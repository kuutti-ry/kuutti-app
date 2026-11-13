import fc from "fast-check";

class RuleViolation extends Error {}

/**
 * Search and shrink an attack's counterexample (#380). Only a true predicate
 * means a violation. A generator, fixture or product exception stays fatal,
 * even if shrinking later finds an ordinary counterexample instead.
 */
export function findViolation<T>(
  arbitrary: fc.Arbitrary<T>,
  violates: (input: T) => boolean,
  seed: number,
) {
  let unexpected: { error: unknown } | undefined;
  const result = fc.check(
    fc.property(arbitrary, (input) => {
      let broken: boolean;
      try {
        broken = violates(input);
      } catch (error) {
        unexpected ??= { error };
        throw error;
      }
      if (broken) throw new RuleViolation("the generated input broke the rule");
    }),
    { seed, numRuns: 100 },
  );
  if (unexpected) throw unexpected.error;
  if (result.failed && !(result.errorInstance instanceof RuleViolation)) {
    throw new Error("property attack could not complete its search", {
      cause: result.errorInstance,
    });
  }
  return {
    found: result.failed,
    seed: result.seed,
    path: result.counterexamplePath,
    input: result.counterexample?.[0] ?? null,
  };
}
