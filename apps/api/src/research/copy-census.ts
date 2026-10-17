import { type AgeBand, RESEARCH_FIELD_KEYS } from "@kuutti/schema";

/**
 * The research copy's census (ADR-029 §4, amending ADR-011 §9). A cell is
 * one value of pond, age band, gender and the research fields; its size is
 * the number of distinct pseudonyms that count, never rows. A day's row is
 * released with a cell's value only when that value is carried, in the copy's
 * files of the previous ninety days and in the day being written, by at least
 * k pseudonyms that count: those whose consent is still live (copy.ts), one
 * per person. A withdrawn one counts for nobody, so one person who gives,
 * withdraws and gives again cannot carry a cell to k under pseudonyms of
 * their own. Counting what the copy has released, not the live table, is
 * what holds k across the whole copy: a cell of three people released
 * generalised in September and joined by seven in October would open exactly
 * in October by the live count, and seven people would carry the value in
 * the copy. Files are never removed, so what a day releases stays carried by
 * at least k pseudonyms for good.
 *
 * Under k, the cascade of ADR-011 §9: the research fields are withheld, then
 * the age band goes to its fixed neighbour pair, then the pond is withheld;
 * a row still under k is dropped and counted. Withheld is `*`, never null:
 * null already says "not chosen" or "not answered".
 */
export const WITHHELD = "*";

/** Each band's fixed pair (ADR-011 §9: "the age band to its neighbour"): a decade or more each. */
export const COARSE_AGE_BAND: Record<AgeBand, string> = {
  "18-24": "18-29",
  "25-29": "18-29",
  "30-34": "30-39",
  "35-39": "30-39",
  "40-49": "40+",
  "50+": "40+",
};

export type Cell = {
  /** The pond's slug; null before the person chose one; WITHHELD when generalised. */
  pond: string | null;
  /** One of AGE_BANDS, or a COARSE_AGE_BAND value when generalised. */
  ageBand: string;
  /** Self-declared; null when not declared. Never withheld (ADR-029 §4's residuals). */
  gender: string | null;
  /** Every research field of the registry: its value, null when not answered, WITHHELD when generalised. */
  fields: Record<string, string | null>;
};

/** Exact, fields withheld, age band coarsened, pond withheld. */
const LEVELS = [0, 1, 2, 3] as const;

export function generalise(cell: Cell, level: (typeof LEVELS)[number]): Cell {
  if (level === 0) return cell;
  return {
    pond: level >= 3 ? WITHHELD : cell.pond,
    // The input is a day's row, whose band the read checked against AGE_BANDS.
    ageBand: level >= 2 ? COARSE_AGE_BAND[cell.ageBand as AgeBand] : cell.ageBand,
    gender: cell.gender,
    fields: Object.fromEntries(RESEARCH_FIELD_KEYS.map((key) => [key, WITHHELD])),
  };
}

/** One string per released value: two cells are one when every column of the file reads the same. */
export function cellKey(cell: Cell): string {
  return JSON.stringify([
    cell.pond,
    cell.ageBand,
    cell.gender,
    ...RESEARCH_FIELD_KEYS.map((key) => cell.fields[key] ?? null),
  ]);
}

/** What the copy has released: per released value, the pseudonyms that carry it. */
export type Released = Map<string, Set<string>>;

type Carried = { researchId: string; cell: Cell };

export function remember(released: Released, rows: readonly Carried[]): void {
  for (const row of rows) {
    const key = cellKey(row.cell);
    let ids = released.get(key);
    if (!ids) {
      ids = new Set();
      released.set(key, ids);
    }
    ids.add(row.researchId);
  }
}

export type Census<R> = {
  /** The rows to write, each with the cell it is released under. */
  released: R[];
  /** Of the released, those released under a generalised cell. */
  generalised: number;
  /** Rows still under k after the last step: left out of the copy, counted. */
  dropped: number;
};

/**
 * A day's rows through the cascade, against what the copy released before.
 * Only the pseudonyms `counts` admits are carriers, today's and the prior's;
 * a row whose own pseudonym does not count is still released or dropped with
 * its cell. A pure function of its input: the same rows, prior and `counts`
 * give the same release, whatever order the rows come in.
 */
export function census<R extends Carried>(
  rows: readonly R[],
  prior: Released,
  k: number,
  counts: (researchId: string) => boolean,
): Census<R> {
  const released: R[] = [];
  let generalised = 0;
  let remaining = rows;
  for (const level of LEVELS) {
    const groups = new Map<string, { cell: Cell; rows: R[] }>();
    for (const row of remaining) {
      const cell = generalise(row.cell, level);
      const key = cellKey(cell);
      const group = groups.get(key);
      if (group) group.rows.push(row);
      else groups.set(key, { cell, rows: [row] });
    }
    const next: R[] = [];
    for (const [key, group] of groups) {
      const carriers = new Set<string>();
      for (const id of prior.get(key) ?? []) if (counts(id)) carriers.add(id);
      for (const row of group.rows) if (counts(row.researchId)) carriers.add(row.researchId);
      if (carriers.size >= k) {
        for (const row of group.rows) released.push({ ...row, cell: group.cell });
        if (level > 0) generalised += group.rows.length;
      } else {
        next.push(...group.rows);
      }
    }
    remaining = next;
  }
  return { released, generalised, dropped: remaining.length };
}
