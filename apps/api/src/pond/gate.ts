import type { Queryable } from "@kuutti/db";
import { type ExportedGate, GENDERS, type Gender } from "@kuutti/schema";

/**
 * The pond gate's rules (#94, #147, ADR-015; TD-10, TD-13, TD-14), pure, and
 * the rows they are kept in. Two things happen to a person with a complete
 * profile, in this order:
 *
 * 1. **Admission.** Most are let into the pond at once. A person competes for
 *    every gender they seek but their own, and each such contest is kept to
 *    its ratio: while the people competing for a gender are more than that
 *    gender can bear (`majority_share_max`, read as a ratio), its newcomers
 *    wait in the order they registered. Nobody is let out when the pond
 *    drifts.
 * 2. **The gate.** Matching opens for an admitted person when the people who
 *    could be shown to them, and they to those, number `gate_k`. It does not
 *    close again: a pool that shrinks makes shorter rounds (TD-11).
 *
 * The rules name no gender: they speak of whom one competes for, whichever
 * it is (TD-14), and of the label a person chose nothing follows (ADR-015
 * §4, amended by #147). What a person is told of either is said in steps,
 * never exactly (`sayPool`, `sayPlace`), and only that is kept. The counting
 * itself reads across slices and lives with the nightly jobs
 * (`jobs/pond-gate.ts`).
 */

/** A person as admission sees them. */
export type Applicant = {
  id: string;
  gender: Gender;
  seeks: readonly Gender[];
  registeredAt: Date;
  /** Let in by an earlier count; no count takes it back. */
  admitted: boolean;
};

/**
 * The genders a person competes for: whom they seek, their own left out,
 * since seeking one's own gender is no contest (the same people stand on
 * both sides, TD-13). A person with no contest waits with nobody.
 */
export function contestsOf(person: Pick<Applicant, "gender" | "seeks">): Gender[] {
  return GENDERS.filter((gender) => gender !== person.gender && person.seeks.includes(gender));
}

/** Whether two people stand in one line: they compete for a gender in common. */
export function competeAlike(
  a: Pick<Applicant, "gender" | "seeks">,
  b: Pick<Applicant, "gender" | "seeks">,
): boolean {
  const theirs = contestsOf(b);
  return contestsOf(a).some((gender) => theirs.includes(gender));
}

export type Admission = {
  /** Newly let in by this count, in the order they were. */
  admitted: string[];
  /** Who waits, with their place among those who compete alike: 1 is next. */
  waiting: Map<string, number>;
};

const byRegistration = (a: Applicant, b: Applicant) =>
  a.registeredAt.getTime() - b.registeredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The contest ratio behind the share (ADR-015 §4): a group kept to at most
 * `shareMax` of two groups is a ratio of at most shareMax / (1 - shareMax)
 * between the two (0.6 is three to two).
 */
const ratioOf = (shareMax: number): number => shareMax / (1 - shareMax);

/** Per gender: how many let-in people compete for it, and how many of it are there to compete for. */
type Tally = { competitors: Record<Gender, number>; supply: Record<Gender, number> };

const tally = (): Tally => ({
  competitors: { woman: 0, man: 0, non_binary: 0 },
  supply: { woman: 0, man: 0, non_binary: 0 },
});

/** A person let in counts for every contest they are in, and as one of their gender for those who compete for it. */
function count(t: Tally, person: Pick<Applicant, "gender" | "seeks">): void {
  const contests = contestsOf(person);
  for (const gender of contests) t.competitors[gender] += 1;
  if (contests.length > 0) t.supply[person.gender] += 1;
}

/**
 * Whether a contest has room for one more: while the competitors are at
 * most those they compete for, always; beyond that, while one more keeps
 * the ratio. An empty pond has room for the first of anybody.
 */
const hasRoom = (t: Tally, gender: Gender, ratio: number): boolean =>
  t.competitors[gender] <= t.supply[gender] ||
  t.competitors[gender] + 1 <= ratio * t.supply[gender];

const mayEnter = (t: Tally, person: Applicant, ratio: number): boolean =>
  contestsOf(person).every((gender) => hasRoom(t, gender, ratio));

/**
 * Who of one pond is let in now. People who compete for nobody are let in at
 * once. Of the rest, in the order of registration, whoever's every contest
 * has room is let in and counted, and the line is read again from its head,
 * so a newcomer who is competed for opens the way for those who waited.
 *
 * At small numbers a contest can stand above its ratio (two of three is
 * more than three to two): the rule is about who is let in next, not a
 * promise about the ratio, which also drifts as people leave (TD-13).
 */
export function admit(people: readonly Applicant[], shareMax: number): Admission {
  const ratio = ratioOf(shareMax);
  const t = tally();
  const admitted: Applicant[] = [];
  const line: Applicant[] = [];
  for (const person of people) {
    if (person.admitted) count(t, person);
    else if (contestsOf(person).length === 0) admitted.push(person);
    else line.push(person);
  }
  line.sort(byRegistration);
  for (;;) {
    const index = line.findIndex((person) => mayEnter(t, person, ratio));
    if (index < 0) break;
    const [next] = line.splice(index, 1);
    if (!next) break;
    count(t, next);
    admitted.push(next);
  }

  const waiting = new Map<string, number>();
  line.forEach((person, index) => {
    const before = line.slice(0, index).filter((other) => competeAlike(other, person)).length;
    waiting.set(person.id, before + 1);
  });
  return { admitted: admitted.sort(byRegistration).map((person) => person.id), waiting };
}

/**
 * Whether a person is let in as the recorded admissions stand, needing
 * nobody else's: the question of the one count that writes one row only, a
 * person's first ask (ADR-015 §7). `admit` decides for everybody at once,
 * and a place given on the strength of admissions that are not written
 * would stand when those never come about: somebody who registered later
 * would be inside, and the one before them in the line.
 *
 * So: people who compete for nobody are let in. Otherwise a person is let
 * in when nobody who competes alike and is not let in registered before
 * them, and their contests have room counting only those who are let in
 * already. Everybody else is told that the night will say.
 */
export function admitsAlone(people: readonly Applicant[], id: string, shareMax: number): boolean {
  const person = people.find((candidate) => candidate.id === id);
  if (!person) return false;
  if (person.admitted) return true;
  if (contestsOf(person).length === 0) return true;
  const passes = people.some(
    (other) =>
      !other.admitted &&
      other.id !== id &&
      competeAlike(other, person) &&
      byRegistration(other, person) < 0,
  );
  if (passes) return false;
  const recorded = people.filter((other) => other.admitted);
  return admit([...recorded, person], shareMax).admitted.includes(id);
}

/**
 * A person's place in the line as the recorded admissions stand: behind
 * everybody who competes alike, is not let in and registered before them.
 * For the same count as `admitsAlone`, and for the same reason: `admit`
 * takes out of the line whoever it would let in, and a place that counted
 * on that would be better than what is written. Said in steps it is "among
 * the next twenty" where the night may find "among the next ten"; it is
 * never the other way round. Null for somebody who competes for nobody.
 */
export function placeAlone(people: readonly Applicant[], id: string): number | null {
  const person = people.find((candidate) => candidate.id === id);
  if (!person) return null;
  if (contestsOf(person).length === 0) return null;
  const before = people.filter(
    (other) =>
      !other.admitted &&
      other.id !== id &&
      competeAlike(other, person) &&
      byRegistration(other, person) < 0,
  );
  return before.length + 1;
}

/**
 * A figure that was said, read in a step: itself while it is a whole number
 * of the step, else rounded down to one, the side that says less. The step
 * (`waitlist_k`) can be changed after a figure was said under another one,
 * and the row holds the figure as it was said. What is served is a whole
 * number of the step it is served with, and a raise says nothing anew of
 * the pool: the figure read this way is a function of what was said, not of
 * the pool. Lowered again, a figure of the coarser step stands as it is
 * until the pool is a step away from it, what was said and not the pool a
 * person later (as the counter keeps its figures through a raise, ADR-013).
 */
export function saidInStep(said: number, step: number): number {
  return Math.floor(said / step) * step;
}

/**
 * The size of a person's pool as it is said to them: in whole steps, rounded
 * down, the first figure like every later one. An exact pool would answer
 * whatever a person asks of it: with a window of one year of birth it says
 * whether the one person of that year seeks somebody like them, which is
 * what `seeks` says and what TD-14 keeps out of everything.
 *
 * On top of the rounding the figure follows slowly: it moves when the pool
 * is a whole step away from what was said, so a pool that goes back and
 * forth over a ten does not show each crossing. What was said is read in the
 * step of today first (`saidInStep`), and followed from there.
 */
export function sayPool(said: number | null, pool: number, step: number): number {
  const rounded = Math.floor(pool / step) * step;
  if (said === null) return rounded;
  const from = saidInStep(said, step);
  return Math.abs(pool - from) >= step ? rounded : from;
}

/**
 * The place in the line as it is said: among the next ten, the next twenty.
 * The line is of people who compete for a gender, so an exact place that
 * moved by one would say that of the one person who came or went. A place
 * said under another step is read in this one the same way, never finer
 * than it.
 */
export function sayPlace(place: number, step: number): number {
  return Math.ceil(Math.max(1, place) / step) * step;
}

/** About how many more are needed, from what is said: never less than one while the gate is closed. */
export function neededFrom(said: number, gateK: number): number {
  return Math.max(1, Math.ceil(gateK) - said);
}

// --- The rows ---------------------------------------------------------------

export type GateRow = {
  pondId: string;
  admittedAt: Date | null;
  /** The place in the line as it is said (`sayPlace`); null unless the person waits. */
  placeSaid: number | null;
  poolSaid: number;
  openedAt: Date | null;
  /** Null while the row waits for the next count to decide anew. */
  countedAt: Date | null;
};

type Row = Record<string, unknown>;

/** The caller's own row (rule 6), or null before the first count. */
export async function readGateRow(db: Queryable, accountId: string): Promise<GateRow | null> {
  const { rows } = await db.query<Row>(
    `SELECT pond_id, admitted_at, place_said, pool_said, opened_at, counted_at
     FROM gate WHERE account_id = $1`,
    [accountId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    pondId: row.pond_id as string,
    admittedAt: (row.admitted_at as Date | null) ?? null,
    placeSaid: (row.place_said as number | null) ?? null,
    poolSaid: row.pool_said as number,
    openedAt: (row.opened_at as Date | null) ?? null,
    countedAt: (row.counted_at as Date | null) ?? null,
  };
}

/**
 * What an emptied row is set to, for the statements that empty one: the
 * person is neither let in nor in the line until the next count has decided.
 * The row itself stays, so that asking does not count them then and there
 * (ADR-015 §7): only a person who was never counted is counted on asking.
 * What was said of the pool stays too. It is what the next figure follows
 * slowly from, and a person who could empty it, by a pond there and back,
 * would have a fresh figure every night and see every crossing of a ten.
 */
export const GATE_EMPTIED =
  "admitted_at = NULL, place_said = NULL, opened_at = NULL, counted_at = NULL";

/** What a person declares of themselves, as far as admission reads it. */
export type Declared = { gender: string | null; seeks: readonly string[] | null };

const isGender = (value: string): value is Gender => (GENDERS as readonly string[]).includes(value);

const contestsDeclared = (declared: Declared): Gender[] | undefined => {
  if (declared.gender === null || declared.seeks === null) return undefined;
  if (!isGender(declared.gender)) return undefined;
  return contestsOf({ gender: declared.gender, seeks: declared.seeks.filter(isGender) });
};

/**
 * Whether a change of gender or of whom one seeks brings the person into a
 * contest they were not in: one that may have to wait. Seeking one's own
 * gender too, or no longer, is no contest and changes nothing here.
 */
export function joinsAContest(before: Declared, after: Declared): boolean {
  const now = contestsDeclared(after);
  if (!now || now.length === 0) return false;
  const then = contestsDeclared(before) ?? [];
  return now.some((gender) => !then.includes(gender));
}

/**
 * Admission is decided anew for a person who joins a contest (ADR-015 §9).
 * Without it a person would compete for one gender, be let in, and declare
 * that they seek another too: past everybody who waits for that one, and
 * counted into the ratio they wait behind. Called in the transaction that
 * writes the change, for the caller's own row (rule 6). Leaving a contest,
 * or changing anything else, takes nothing back.
 */
export async function admissionAnew(
  db: Queryable,
  accountId: string,
  before: Declared,
  after: Declared,
): Promise<boolean> {
  if (!joinsAContest(before, after)) return false;
  const result = await db.query(`UPDATE gate SET ${GATE_EMPTIED} WHERE account_id = $1`, [
    accountId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

/** The export (#51): the row as it is held, which is what the person is told. */
export async function exportGate(db: Queryable, accountId: string): Promise<ExportedGate | null> {
  const row = await readGateRow(db, accountId);
  if (!row) return null;
  return {
    pondId: row.pondId,
    admittedAt: row.admittedAt?.toISOString() ?? null,
    placeSaid: row.placeSaid,
    poolSaid: row.poolSaid,
    openedAt: row.openedAt?.toISOString() ?? null,
    countedAt: row.countedAt?.toISOString() ?? null,
  };
}

/** Erasure (TD-7): the person's place at the gate. */
export async function deleteGateOfAccount(db: Queryable, accountId: string): Promise<number> {
  const result = await db.query("DELETE FROM gate WHERE account_id = $1", [accountId]);
  return result.rowCount ?? 0;
}
