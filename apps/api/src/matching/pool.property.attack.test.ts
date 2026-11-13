import { type DealBreaker, GENDERS } from "@kuutti/schema";
import fc from "fast-check";
import { describe, expect } from "vitest";
import { attack } from "../test/attack.ts";
import { findViolation } from "../test/property-attack.ts";
import { inEachOthersPool, type PoolPerson, relaxedBy } from "./pool.ts";

// PROPERTY pile (#380): generate an otherwise eligible pair, put exactly
// one hard refusal in its path, and try to get through. In contrast to a
// mostly-ineligible random population, every sample reaches that refusal.
// These are existing rules (7, ADR-015/030/042/061), not new parameters.
type Generated<A> = A extends fc.Arbitrary<infer T> ? T : never;
const SEED = 3801102;
const source = fc.record({
  aGender: fc.constantFrom(...GENDERS),
  bGender: fc.constantFrom(...GENDERS),
  aAge: fc.integer({ min: 19, max: 98 }),
  bAge: fc.integer({ min: 19, max: 98 }),
  x: fc.integer({ min: 0, max: 100_000 }),
  y: fc.integer({ min: 0, max: 100_000 }),
  reverse: fc.boolean(),
});
type Source = Generated<typeof source>;
function pair(input: Source): [PoolPerson, PoolPerson] {
  const person = (
    identityId: string,
    gender: PoolPerson["gender"],
    seeks: PoolPerson["gender"],
    age: number,
  ): PoolPerson => ({
    identityId,
    gender,
    seeks: [seeks],
    age,
    ageWindow: { min: 18, max: 99 },
    intent: "long_term",
    fields: { intent: "long_term", smoking: "never" },
    blocks: new Set(),
    dealBreakers: [],
    home: { x: input.x, y: input.y, edges: { nearby: 5, close: 15, around: 50 } },
  });
  return [
    person("a", input.aGender, input.bGender, input.aAge),
    person("b", input.bGender, input.aGender, input.bAge),
  ];
}
const admitted = (a: PoolPerson, b: PoolPerson, reverse: boolean) =>
  reverse ? inEachOthersPool(b, a) : inEachOthersPool(a, b);
const noSmoking: DealBreaker = { field: "smoking", accept: ["never"], includeUnknown: false };
const aside = [{ field: "smoking", kind: "aside" }] as const;
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

describe("hard-filter property attacks (#380)", () => {
  function blocked(input: Source, block: boolean) {
    const [a, b] = pair(input);
    a.dealBreakers = [noSmoking];
    b.blocks = new Set(block ? [a.identityId] : ["unrelated-identity"]);
    return admitted(relaxedBy(a, aside), b, input.reverse);
  }
  probe(
    "use a relaxation to pass the other person's block",
    source,
    (s) => blocked(s, true),
    (s) => blocked(s, false),
  );

  function unwantedGender(input: Source, reject: boolean) {
    const [a, b] = pair(input);
    a.dealBreakers = [noSmoking];
    b.seeks = reject ? GENDERS.filter((gender) => gender !== a.gender) : [a.gender];
    return admitted(relaxedBy(a, aside), b, input.reverse);
  }
  probe(
    "use a relaxation to pass the other person's sought genders",
    source,
    (s) => unwantedGender(s, true),
    (s) => unwantedGender(s, false),
  );

  const ageEdge = fc.tuple(source, fc.boolean());
  function outsideAge([input, below]: Generated<typeof ageEdge>, reject: boolean) {
    const [a, b] = pair(input);
    a.dealBreakers = [noSmoking];
    b.ageWindow = below
      ? { min: a.age + Number(reject), max: 99 }
      : { min: 18, max: a.age - Number(reject) };
    return admitted(relaxedBy(a, aside), b, input.reverse);
  }
  probe(
    "cross either inclusive age-window edge by relaxing another field",
    ageEdge,
    (s) => outsideAge(s, true),
    (s) => outsideAge(s, false),
  );

  const intents = fc.tuple(
    source,
    fc.constantFrom(
      ["long_term", "casual"] as const,
      ["dance_partner", "long_term"] as const,
      ["dance_partner", "casual"] as const,
      ["dance_partner", "open_to_either"] as const,
    ),
  );
  function incompatible([input, [first, second]]: Generated<typeof intents>, reject: boolean) {
    const [a, b] = pair(input);
    a.intent = first;
    b.intent = reject ? second : first;
    a.fields = { ...a.fields, intent: a.intent };
    b.fields = { ...b.fields, intent: b.intent };
    a.dealBreakers = [noSmoking];
    return admitted(relaxedBy(a, aside), b, input.reverse);
  }
  probe(
    "make incompatible intents fit by dropping a deal-breaker",
    intents,
    (s) => incompatible(s, true),
    (s) => incompatible(s, false),
  );

  function unanswered(input: Source, missing: boolean) {
    const [a, b] = pair(input);
    a.dealBreakers = [noSmoking];
    b.fields = missing ? { intent: b.intent } : { ...b.fields, smoking: "never" };
    return admitted(a, b, input.reverse);
  }
  probe(
    "treat an unanswered candidate field as an accepted answer",
    source,
    (s) => unanswered(s, true),
    (s) => unanswered(s, false),
  );

  const rejectedSmoking = fc.tuple(
    source,
    fc.constantFrom("sometimes", "regularly", "quitting", "vaping"),
  );
  function relaxUnknown([input, smoking]: Generated<typeof rejectedSmoking>, explicit: boolean) {
    const [a, b] = pair(input);
    a.dealBreakers = [noSmoking];
    b.fields = explicit ? { ...b.fields, smoking } : { intent: b.intent };
    return admitted(relaxedBy(a, [{ field: "smoking", kind: "unanswered" }]), b, input.reverse);
  }
  probe(
    "turn the unanswered relaxation into permission for a rejected explicit answer",
    rejectedSmoking,
    (s) => relaxUnknown(s, true),
    (s) => relaxUnknown(s, false),
  );

  function relaxOtherSide([input, smoking]: Generated<typeof rejectedSmoking>, both: boolean) {
    const [a, b] = pair(input);
    a.fields = { ...a.fields, smoking };
    a.dealBreakers = [noSmoking];
    b.dealBreakers = [noSmoking];
    return admitted(relaxedBy(a, aside), both ? relaxedBy(b, aside) : b, input.reverse);
  }
  probe(
    "set aside my deal-breaker and silently waive the other person's too",
    rejectedSmoking,
    (s) => relaxOtherSide(s, false),
    (s) => relaxOtherSide(s, true),
  );

  const heights = fc.tuple(
    source,
    fc.integer({ min: 150, max: 200 }),
    fc.integer({ min: 0, max: 10 }),
  );
  function notTaller([input, height, difference]: Generated<typeof heights>, taller: boolean) {
    const [a, b] = pair(input);
    a.fields = { ...a.fields, height };
    b.fields = { ...b.fields, height: taller ? height + 1 + difference : height - difference };
    a.dealBreakers = [{ field: "height", accept: ["taller"], includeUnknown: false }];
    return admitted(a, b, input.reverse);
  }
  probe(
    "pass a strict taller-than filter with an equal or shorter height",
    heights,
    (s) => notTaller(s, false),
    (s) => notTaller(s, true),
  );

  const distances = fc.tuple(source, fc.integer({ min: 1, max: 100 }));
  function distanceEdge([input, edge]: Generated<typeof distances>, outside: boolean) {
    const [a, b] = pair(input);
    const edges = { nearby: edge, close: edge + 10, around: edge + 50 };
    a.home = { ...a.home, edges };
    b.home = { x: input.x + edge * 1000 - Number(!outside), y: input.y, edges };
    // Distance has no own answer and must never become a paused filter.
    a.dealBreakers = [{ field: "distance", accept: ["nearby"], includeUnknown: true }];
    return admitted(a, b, input.reverse);
  }
  probe(
    "call the outer edge nearby, or pause distance for lacking a profile field",
    distances,
    (s) => distanceEdge(s, true),
    (s) => distanceEdge(s, false),
  );
});
