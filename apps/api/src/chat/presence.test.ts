import { describe, expect, it } from "vitest";
import { createPresence, type LiveSocket } from "./presence.ts";

// The registry of open sockets (#349): when an account comes to read online
// and stops, the limit per account and its oldest, and who reads as online,
// a shadow ban put on or lifted included.

const socket = (accountId: string, hidden = false): LiveSocket => ({
  accountId,
  sessionId: `${accountId}-session`,
  hidden,
  send: () => undefined,
  close: () => undefined,
});

describe("the registry of open sockets", () => {
  it("says when the account comes to read online and when it stops, and nothing for one it never had", () => {
    const presence = createPresence(5);
    const one = socket("a");
    const two = socket("a");
    expect(presence.add(one)).toEqual({ shown: true, evicted: [] });
    expect(presence.add(two)).toEqual({ shown: false, evicted: [] });
    expect(presence.socketsOf("a")).toEqual([one, two]);
    expect(presence.remove(one)).toEqual({ changed: false });
    expect(presence.remove(one)).toEqual({ changed: false });
    expect(presence.remove(two)).toEqual({ changed: true });
    expect(presence.remove(socket("b"))).toEqual({ changed: false });
    expect(presence.socketsOf("a")).toEqual([]);
    expect(presence.all()).toEqual([]);
  });

  it("hands back the oldest past the limit, the new one already in", () => {
    const presence = createPresence(2);
    const [first, second, third] = [socket("a"), socket("a"), socket("a")];
    presence.add(first);
    presence.add(second);
    expect(presence.add(third)).toEqual({ shown: false, evicted: [first] });
    expect(presence.socketsOf("a")).toContain(third);
  });

  it("reads a shadow-banned account as offline, open sockets or not, and says no change for it", () => {
    const presence = createPresence(5);
    const hidden = socket("hidden", true);
    expect(presence.add(hidden)).toEqual({ shown: false, evicted: [] });
    presence.add(socket("seen"));
    expect(presence.online("hidden")).toBe(false);
    expect(presence.online("seen")).toBe(true);
    expect(presence.online("nobody")).toBe(false);
    expect(
      presence
        .all()
        .map((s) => s.accountId)
        .sort(),
    ).toEqual(["hidden", "seen"]);
    expect(presence.remove(hidden)).toEqual({ changed: false });
  });

  it("hides every socket of an account when a ban comes, by a ping or by a new socket, and shows them when it is lifted", () => {
    const presence = createPresence(5);
    const [one, two] = [socket("a"), socket("a")];
    presence.add(one);
    presence.add(two);
    expect(presence.setHidden("a", true)).toEqual({ changed: true });
    expect([one.hidden, two.hidden, presence.online("a")]).toEqual([true, true, false]);
    expect(presence.setHidden("a", true)).toEqual({ changed: false });
    expect(presence.setHidden("a", false)).toEqual({ changed: true });
    expect(presence.online("a")).toBe(true);
    // A socket opened after the ban carries it to the others at once.
    expect(presence.add(socket("a", true))).toEqual({ shown: false, evicted: [] });
    expect(presence.online("a")).toBe(false);
    expect([one.hidden, two.hidden]).toEqual([true, true]);
    // And one opened after the lift shows the account again.
    expect(presence.add(socket("a"))).toEqual({ shown: true, evicted: [] });
    expect(presence.setHidden("nobody", true)).toEqual({ changed: false });
  });
});
