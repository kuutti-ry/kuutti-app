import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { attackFails } from "../../../../scripts/lib/attack.ts";
import { findViolation } from "./property-attack.ts";

const SEED = 380;

describe("a seeded property attack (#380)", () => {
  it("finds and shrinks a violation and repeats it with the same seed", () => {
    const search = () => findViolation(fc.integer({ min: 0, max: 100 }), (n) => n >= 7, SEED);
    expect(search()).toMatchObject({ found: true, input: 7, seed: SEED });
    expect(search()).toEqual(search());
  });

  it("reports a held rule only after the generated inputs were exercised", () => {
    const seen = new Set<number>();
    expect(
      findViolation(
        fc.integer({ min: 0, max: 100 }),
        (n) => {
          seen.add(n);
          return n < 0;
        },
        SEED,
      ),
    ).toMatchObject({ found: false, input: null, path: null });
    expect(seen.size).toBeGreaterThan(20);
  });

  it.each([new TypeError("broken fixture"), undefined])(
    "preserves an unexpected thrown value: %s",
    (error) => {
      expect(() =>
        findViolation(
          fc.constant(1),
          () => {
            throw error;
          },
          SEED,
        ),
      ).toThrow(error);
    },
  );

  it("keeps a runtime error fatal even if a shrink later finds a rule violation", () => {
    const error = new TypeError("first evaluation failed");
    let calls = 0;
    expect(() =>
      findViolation(
        fc.integer({ min: 1, max: 100 }),
        () => {
          if (calls++ === 0) throw error;
          return true;
        },
        SEED,
      ),
    ).toThrow(error);
    expect(calls).toBeGreaterThan(1);
  });

  it("fails when preconditions discard every input instead of calling that a held rule", () => {
    expect(() =>
      findViolation(
        fc.constant(1),
        () => {
          fc.pre(false);
          return false;
        },
        SEED,
      ),
    ).toThrow();
  });

  it("keeps fixture assertions outside the attack inversion", async () => {
    await expect(
      attackFails("broken fixture", {
        attempt: () =>
          findViolation(
            fc.constant(1),
            (n) => {
              expect(n).toBe(2);
              return false;
            },
            SEED,
          ),
        control: () => findViolation(fc.constant(1), () => true, SEED),
        succeeds: (seen) => expect(seen.found).toBe(true),
      }),
    ).rejects.toThrow(/expected 1 to be 2/);
  });

  it("turns a discovered counterexample red through the shared attack runner", async () => {
    await expect(
      attackFails("generated violation", {
        attempt: () => findViolation(fc.nat(), () => true, SEED),
        control: () => findViolation(fc.nat(), () => true, SEED),
        succeeds: (seen) => expect(seen.found).toBe(true),
      }),
    ).rejects.toThrow("the rule was broken: generated violation");
  });
});
