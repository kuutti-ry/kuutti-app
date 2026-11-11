/**
 * A self-test case of a check that lists problems: the problems, in order,
 * start with the expected words. A miss says both and exits 1, so the real
 * check never runs on a checker its own cases disprove.
 */
export function expectProblems(
  name: string,
  problems: readonly string[],
  expected: readonly string[],
): void {
  const matches =
    problems.length === expected.length &&
    expected.every((start, i) => problems[i]?.startsWith(start));
  if (!matches) {
    console.error(`✖ self-test, ${name}: expected ${JSON.stringify(expected)}`);
    console.error(`  got ${JSON.stringify(problems)}`);
    process.exit(1);
  }
}
