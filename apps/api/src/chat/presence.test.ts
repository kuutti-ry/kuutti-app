import { describe, expect, it } from "vitest";
import { createPresence, type LiveSocket } from "./presence.ts";

// The registry of open sockets (#349): first and last, the limit per account
// and its oldest, and who reads as online.

const socket = (accountId: string, hidden = false): LiveSocket => ({
  accountId,
  sessionId: `${accountId}-session`,
  hidden,
  send: () => undefined,
  close: () => undefined,
});

describe("the registry of open sockets", () => {
  it("says the first and the last of an account's sockets, and nothing for one it never had", () => {
    const presence = createPresence(5);
    const one = socket("a");
    const two = socket("a");
    expect(presence.add(one)).toEqual({ first: true, evicted: [] });
    expect(presence.add(two)).toEqual({ first: false, evicted: [] });
    expect(presence.socketsOf("a")).toEqual([one, two]);
    expect(presence.remove(one)).toEqual({ last: false });
    expect(presence.remove(one)).toEqual({ last: false });
    expect(presence.remove(two)).toEqual({ last: true });
    expect(presence.remove(socket("b"))).toEqual({ last: false });
    expect(presence.socketsOf("a")).toEqual([]);
    expect(presence.all()).toEqual([]);
  });

  it("hands back the oldest past the limit, the new one already in", () => {
    const presence = createPresence(2);
    const [first, second, third] = [socket("a"), socket("a"), socket("a")];
    presence.add(first);
    presence.add(second);
    expect(presence.add(third)).toEqual({ first: false, evicted: [first] });
    expect(presence.socketsOf("a")).toContain(third);
  });

  it("reads a shadow-banned account as offline, open sockets or not", () => {
    const presence = createPresence(5);
    presence.add(socket("hidden", true));
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
  });
});
