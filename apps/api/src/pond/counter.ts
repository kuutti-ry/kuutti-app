import type { Queryable } from "@kuutti/db";
import {
  type PondCounterCounts,
  type PondCounterResponse,
  type PondSeeks,
  pondCounterK,
  publishCounts,
  seeksShares,
} from "@kuutti/schema";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import * as repo from "./repo.ts";

/**
 * The pond counter's read (#54, ADR-013): for every pond the figures it stands
 * on, each through `publishCounts`, which says a number only where at least k
 * people stand behind it. The figures are written by the nightly job in
 * `jobs/pond-counter.ts`, which is where the accounts are counted; the one
 * person's row read here is the caller's own, for their pond's bar.
 *
 * Raw parameterised SQL for the same reason as pond/repo.ts: Deps.db is the
 * Queryable seam the test harness hands a rolled-back transaction through.
 * The public figures are aggregates per pond, the same for every reader, so
 * there is no caller to scope them by (rule 6 is about a session's own rows).
 * The bar is not the same for every reader, and its one read is scoped.
 */
const POND_COUNTER_K_KEY = "pond_counter_k";

/** The threshold in force: `matching_config.pond_counter_k`, never below the floor of packages/schema. */
export async function readPondCounterK(db: Queryable): Promise<number> {
  return pondCounterK(await matchingConfigNumber(db, POND_COUNTER_K_KEY));
}

type FiguresRow = {
  pond_id: string;
  day: string;
  verified: number;
  woman: number;
  man: number;
  non_binary: number;
  finishing: number;
  seeks_men: number;
  seeks_everyone: number;
  seeks_women: number;
};

export type StandingFigures = { day: string; counts: PondCounterCounts };

/** The figures every pond stands on, exact: for the job that moves them and the read that publishes them. */
export async function readStandingFigures(db: Queryable): Promise<Map<string, StandingFigures>> {
  const { rows } = await db.query<FiguresRow>(
    `SELECT pond_id, to_char(day, 'YYYY-MM-DD') AS day, verified, woman, man, non_binary, finishing,
            seeks_men, seeks_everyone, seeks_women
     FROM pond_counter`,
  );
  return new Map(
    rows.map((row) => [
      row.pond_id,
      {
        day: row.day,
        counts: {
          verified: row.verified,
          woman: row.woman,
          man: row.man,
          nonBinary: row.non_binary,
          finishing: row.finishing,
          seeksMen: row.seeks_men,
          seeksEveryone: row.seeks_everyone,
          seeksWomen: row.seeks_women,
        },
      },
    ]),
  );
}

/**
 * What the caller's own pond may say of whom its people seek (#507, ADR-013
 * §12): none without a pond, and null shares until every band is at least k.
 * Scoped by the caller in the query: a pond's bands are read for one's own pond
 * only, and only as shares.
 */
async function readOwnBar(
  db: Queryable,
  accountId: string,
  k: number,
): Promise<{ pondId: string; seeks: PondSeeks | null } | null> {
  const { rows } = await db.query<
    Pick<FiguresRow, "pond_id" | "seeks_men" | "seeks_everyone" | "seeks_women">
  >(
    `SELECT s.pond_id, s.seeks_men, s.seeks_everyone, s.seeks_women
     FROM account a
     JOIN pond_counter s ON s.pond_id = a.pond_id
     WHERE a.id = $1`,
    [accountId],
  );
  const row = rows[0];
  if (!row) return null;
  const bands = {
    seeksMen: row.seeks_men,
    seeksEveryone: row.seeks_everyone,
    seeksWomen: row.seeks_women,
  };
  return { pondId: row.pond_id, seeks: seeksShares(bands, k) };
}

/**
 * Every pond, each with what may be said of it, and with a caller the bar of
 * their own pond as well (ADR-013 §18), so a read with no caller carries no band
 * at all.
 */
export async function readPondCounter(
  db: Queryable,
  accountId?: string,
): Promise<PondCounterResponse> {
  const k = await readPondCounterK(db);
  const standing = await readStandingFigures(db);
  const ponds = await repo.listPonds(db);
  const bar = accountId === undefined ? null : await readOwnBar(db, accountId, k);
  return {
    k,
    ponds: ponds.map((pond) => {
      // A pond created after the last count has no row yet: listed, with no number.
      const figures = standing.get(pond.id) ?? null;
      const published = publishCounts(figures?.counts ?? null, k);
      // No number, no day: when a small pond was last counted is nobody's business.
      return {
        pond,
        day: published.verified === null ? null : (figures?.day ?? null),
        ...published,
        seeks: pond.id === bar?.pondId ? bar.seeks : null,
      };
    }),
  };
}
