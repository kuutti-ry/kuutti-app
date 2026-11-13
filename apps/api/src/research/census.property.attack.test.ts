import { AGE_BANDS, RESEARCH_K_MIN } from "@kuutti/schema";
import fc from "fast-check";
import { describe, expect } from "vitest";
import { attack } from "../test/attack.ts";
import { findViolation } from "../test/property-attack.ts";
import { type Cell, cellKey, census, generalise, type Released, remember } from "./copy-census.ts";

// PROPERTY pile (#380, ADR-029 §4). Construct cells on both sides of the
// release boundary, with hostile row multiplicity, consent and history.
// k is the existing policy; generated sizes do not change its value.
const K = RESEARCH_K_MIN;
type Generated<A> = A extends fc.Arbitrary<infer T> ? T : never;
const SEED = 3801103;
const cell = fc.record({
  pond: fc.constantFrom("otaniemi", "helsinki", null),
  ageBand: fc.constantFrom(...AGE_BANDS),
  gender: fc.constantFrom("woman", "man", "non_binary", null),
  fields: fc.record({ intent: fc.constantFrom("long_term", "casual", null) }),
});
const below = fc.integer({ min: 1, max: K - 1 });
const everyone = () => true;
const rows = (count: number, value: Cell, prefix = "person") =>
  Array.from({ length: count }, (_, i) => ({ researchId: `${prefix}-${i}`, cell: value }));
function probe<T>(
  name: string,
  arbitrary: fc.Arbitrary<T>,
  attempt: (input: T) => boolean,
  control: (input: T) => boolean,
) {
  attack(name, {
    attempt: () => findViolation(arbitrary, attempt, SEED),
    control: () => findViolation(arbitrary, control, SEED),
    succeeds: (seen) => expect(seen.found).toBe(true),
  });
}

describe("research property attacks (#380)", () => {
  const duplicates = fc.tuple(cell, below, fc.integer({ min: 2, max: 30 }));
  function repeatRows([value, people, repeats]: Generated<typeof duplicates>, fill: boolean) {
    const today = rows(people, value).flatMap((row) =>
      Array.from({ length: repeats }, () => ({ ...row })),
    );
    if (fill) today.push(...rows(K - people, value, "new"));
    return census(today, new Map(), K, everyone).released.length > 0;
  }
  probe(
    "inflate a small research cell with repeated events of the same people",
    duplicates,
    (s) => repeatRows(s, false),
    (s) => repeatRows(s, true),
  );

  function priorConsent(value: Cell, withdrawn: boolean) {
    const prior: Released = new Map();
    remember(prior, rows(K - 1, value));
    return (
      census(rows(1, value, "today"), prior, K, (id) => !withdrawn || id !== "person-0").released
        .length > 0
    );
  }
  probe(
    "count a withdrawn pseudonym from an earlier file toward today's k",
    cell,
    (s) => priorConsent(s, true),
    (s) => priorConsent(s, false),
  );

  function todayConsent(value: Cell, withdrawn: boolean) {
    return (
      census(rows(K, value), new Map(), K, (id) => !withdrawn || id !== "person-0").released
        .length > 0
    );
  }
  probe(
    "count a withdrawn pseudonym in today's rows toward k",
    cell,
    (s) => todayConsent(s, true),
    (s) => todayConsent(s, false),
  );

  const history = fc.tuple(cell, below);
  function finerThanHistory([value, people]: Generated<typeof history>, exact: boolean) {
    const prior: Released = new Map();
    remember(prior, rows(K, exact ? value : generalise(value, 1), "prior"));
    return census(rows(people, value, "today"), prior, K, everyone).released.some(
      (row) => cellKey(row.cell) === cellKey(value),
    );
  }
  probe(
    "use previously withheld values to open a small exact cell",
    history,
    (s) => finerThanHistory(s, false),
    (s) => finerThanHistory(s, true),
  );

  const genders = fc.tuple(cell, below);
  function mergeGenders([value, first]: Generated<typeof genders>, same: boolean) {
    const a = { ...value, gender: "woman" };
    const b = { ...value, gender: same ? "woman" : "non_binary" };
    return (
      census([...rows(first, a, "a"), ...rows(K - first, b, "b")], new Map(), K, everyone).released
        .length > 0
    );
  }
  probe(
    "merge different genders at the final generalisation step to reach k",
    genders,
    (s) => mergeGenders(s, false),
    (s) => mergeGenders(s, true),
  );

  const stages = fc.tuple(cell, below, fc.integer({ min: K, max: K * 2 }));
  function borrowReleased([value, small, large]: Generated<typeof stages>, heldTogether: boolean) {
    const a = { ...value, fields: { intent: "long_term" } };
    const b = { ...value, fields: { intent: "casual" } };
    const today = [...rows(heldTogether ? K - 1 : large, a, "fine"), ...rows(small, b, "small")];
    return census(today, new Map(), K, everyone).released.some((row) =>
      row.researchId.startsWith("small-"),
    );
  }
  probe(
    "reuse people already released exactly as carriers of a coarser small cell",
    stages,
    (s) => borrowReleased(s, false),
    (s) => borrowReleased(s, true),
  );
});
