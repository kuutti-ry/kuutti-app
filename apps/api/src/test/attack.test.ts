import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  type Attack,
  attackFails,
  attackWith,
  holeStands,
  isFailedAssertion,
  type Runner,
} from "../../../../scripts/lib/attack.ts";
import { attack } from "./attack.ts";

/** A runner that keeps what it was given, so a test can run each part and see how it ends. */
function recorder() {
  const registered = new Map<string, () => Promise<void>>();
  const runner: Runner = (name, run) => void registered.set(name, run);
  return { runner, registered };
}

/** An attack on a door: `attempt` tries a key, and the violation is that it opened. */
const door = (over: Partial<Attack<{ opened: boolean }>> = {}): Attack<{ opened: boolean }> => ({
  attempt: () => ({ opened: false }),
  control: () => ({ opened: true }),
  succeeds: (seen) => expect(seen.opened).toBe(true),
  ...over,
});
const opens = () => ({ opened: true });

describe("attack (#380)", () => {
  it("is green while the rule holds: the violation's assertion fails", async () => {
    await expect(attackFails("a wrong key", door())).resolves.toBeUndefined();
  });

  it("is red with the attack's name when the violation happens", async () => {
    await expect(attackFails("a wrong key", door({ attempt: opens }))).rejects.toThrow(
      "the rule was broken: a wrong key",
    );
  });

  it.each([
    ["thrown", () => Promise.reject(new TypeError("no such door"))],
    [
      "thrown synchronously",
      () => {
        throw new TypeError("no such door");
      },
    ],
  ])(
    "is red as itself when the attempt breaks, %s: a broken test never reads as a rule that held",
    async (_how, attempt) => {
      await expect(attackFails("a wrong key", door({ attempt }))).rejects.toThrow("no such door");
    },
  );

  it("is red when the attempt's own assertion fails: only the violation's assertion counts", async () => {
    const attempt = () => {
      expect("the handle").toBe("found");
      return { opened: false };
    };
    await expect(attackFails("a wrong key", door({ attempt }))).rejects.toThrow(/the handle/);
  });

  it("is red as itself when the violation's check breaks on something other than its assertion", async () => {
    const succeeds = (seen: { opened: boolean }) => {
      (seen as unknown as { lock: { turned: boolean } }).lock.turned.valueOf();
    };
    await expect(attackFails("a wrong key", door({ succeeds }))).rejects.toThrow(TypeError);
  });

  it("waits for an asynchronous attempt and an asynchronous check", async () => {
    const held = door({
      attempt: async () => ({ opened: false }),
      succeeds: async (seen) => expect(seen.opened).toBe(true),
    });
    await expect(attackFails("a wrong key", held)).resolves.toBeUndefined();
    const broken = door({ attempt: async () => opens(), succeeds: held.succeeds });
    await expect(attackFails("a wrong key", broken)).rejects.toThrow("the rule was broken");
  });

  it("takes node:assert's failure for a failed assertion too, as a script's self-test raises it", async () => {
    const held = door({ succeeds: (seen) => assert.equal(seen.opened, true) });
    await expect(attackFails("a wrong key", held)).resolves.toBeUndefined();
  });

  it.each([
    [new Error("the rule was broken"), false],
    [new TypeError("x is not a function"), false],
    ["a string", false],
    [null, false],
    [Object.assign(new Error("expected 1 to be 2"), { matcherResult: { pass: false } }), true],
  ])("tells a failed assertion from a broken test: %s is %s", (error, expected) => {
    expect(isFailedAssertion(error)).toBe(expected);
  });

  it("registers the control and the attack under their names", async () => {
    const { runner, registered } = recorder();
    attackWith(runner)("a wrong key", door());
    expect([...registered.keys()]).toEqual(["control: a wrong key", "attack: a wrong key"]);
    await expect(registered.get("control: a wrong key")?.()).resolves.toBeUndefined();
    await expect(registered.get("attack: a wrong key")?.()).resolves.toBeUndefined();
  });

  it("fails the control when the right way does not show the violation: the check cannot see what it looks for", async () => {
    const { runner, registered } = recorder();
    attackWith(runner)("a wrong key", door({ control: () => ({ opened: false }) }));
    await expect(registered.get("control: a wrong key")?.()).rejects.toSatisfy(isFailedAssertion);
  });
});

describe("an open hole (#380)", () => {
  it("is green while its attack still goes through", async () => {
    await expect(holeStands("a wrong key", door({ attempt: opens }))).resolves.toBeUndefined();
  });

  it("is red once the rule holds, until the mark comes off", async () => {
    await expect(holeStands("a wrong key", door())).rejects.toThrow(
      "this hole is closed, take `open` off its attack: a wrong key",
    );
  });

  it("is red as itself when its attempt breaks: a broken test is no hole that stands", async () => {
    const attempt = () => Promise.reject(new TypeError("no such door"));
    await expect(holeStands("a wrong key", door({ attempt }))).rejects.toThrow("no such door");
  });

  it("is registered under the issue that holds it, runs, and keeps its control", async () => {
    const { runner, registered } = recorder();
    attackWith(runner)("a wrong key", door({ attempt: opens, open: "#1" }));
    expect([...registered.keys()]).toEqual([
      "control: a wrong key",
      "attack (open #1): a wrong key",
    ]);
    await expect(registered.get("control: a wrong key")?.()).resolves.toBeUndefined();
    await expect(registered.get("attack (open #1): a wrong key")?.()).resolves.toBeUndefined();
  });

  it("takes a table's row that carries no mark for an attack that must fail", async () => {
    const { runner, registered } = recorder();
    attackWith(runner)("a wrong key", door({ attempt: opens, open: undefined }));
    await expect(registered.get("attack: a wrong key")?.()).rejects.toThrow("the rule was broken");
  });
});

// The API's own binding, on Vitest itself: two pairs that run as four tests of this file.
attack("the binding registers with Vitest", door());
attack("the binding registers an open hole with Vitest", door({ attempt: opens, open: "#380" }));
