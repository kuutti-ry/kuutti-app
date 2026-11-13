/**
 * attack: a test that tries to make Kuutti do what it must not, and is green
 * only while that fails (#380).
 *
 * An attack has three parts. `attempt` does the thing the wrong way and hands
 * back what it saw. `succeeds` asserts, on that, that the wrong thing happened.
 * `control` does the same thing rightly, or plants the wrong thing where it
 * never happens rightly, and has to satisfy `succeeds`: the same run shows
 * that the assertion can see what it looks for.
 *
 * - `succeeds` fails on its assertion: the rule held, and the attack is green.
 * - `succeeds` passes: red, "the rule was broken".
 * - Anything else that throws, in `attempt` or in `succeeds`, is red as itself.
 *   A typo, a moved route or a broken fixture never reads as a rule that held,
 *   which Vitest's `test.fails` and Jest's `test.failing` cannot tell apart.
 *
 * A hole that waits for its fix carries `open`, the issue that holds it. Its
 * attack still runs, under that name, and is green while it goes through, so
 * every run checks the list of open holes. Once the rule holds it is red,
 * "this hole is closed", until the mark comes off: a fix and its attack land
 * together, and a mark never outlives its hole.
 *
 * It lives outside every workspace because all of them use this one copy, by
 * a relative import. It imports no runner: each workspace binds its own `it`
 * (`attackWith`), Vitest's or Jest's.
 */
export type Attack<Seen> = {
  attempt: () => Seen | Promise<Seen>;
  control: () => Seen | Promise<Seen>;
  succeeds: (seen: Seen) => void | Promise<void>;
  open?: string | undefined;
};

/** A runner's `it`, as far as an attack needs it. */
export type Runner = (name: string, run: () => Promise<void>) => void;

/**
 * A failed assertion, as opposed to a broken test: Vitest's and node:assert's
 * AssertionError by its name, Jest's matcher error by the result it carries.
 */
export function isFailedAssertion(error: unknown): boolean {
  return error instanceof Error && (error.name === "AssertionError" || "matcherResult" in error);
}

/** Whether the violation happened: anything but its assertion failing is the test's own failure, thrown as it is. */
async function wentThrough<Seen>(attack: Attack<Seen>): Promise<boolean> {
  const seen = await attack.attempt();
  try {
    await attack.succeeds(seen);
    return true;
  } catch (error) {
    if (isFailedAssertion(error)) return false;
    throw error;
  }
}

/** The attack itself: resolves while the rule holds, rejects when it broke or when the test did. */
export async function attackFails<Seen>(name: string, attack: Attack<Seen>): Promise<void> {
  if (await wentThrough(attack)) throw new Error(`the rule was broken: ${name}`);
}

/** An open hole's attack: resolves while it still goes through, rejects once the rule holds or when the test broke. */
export async function holeStands<Seen>(name: string, attack: Attack<Seen>): Promise<void> {
  if (!(await wentThrough(attack))) {
    throw new Error(`this hole is closed, take \`open\` off its attack: ${name}`);
  }
}

/** Registers an attack and its control with a runner: `const attack = attackWith(it)`. */
export function attackWith(it: Runner) {
  return <Seen>(name: string, attack: Attack<Seen>): void => {
    it(`control: ${name}`, async () => {
      await attack.succeeds(await attack.control());
    });
    if (attack.open === undefined) it(`attack: ${name}`, () => attackFails(name, attack));
    else it(`attack (open ${attack.open}): ${name}`, () => holeStands(name, attack));
  };
}
