import { type Queryable, transaction } from "@kuutti/db";
import {
  ageBandOf,
  type Gender,
  RESEARCH_EVENTS,
  type ResearchEventName,
  type ResearchEventProps,
  type ResearchSnapshot,
  researchFieldsOf,
} from "@kuutti/schema";
import type { Logger } from "../lib/logger.ts";
import { localYearMonth } from "../media/index.ts";
import * as repo from "./repo.ts";

/**
 * The one door for research events (#50, TD-5, ADR-011). Server-side only,
 * against the registry in packages/schema: a name the registry lacks does not
 * compile, props it refuses are logged (paths, never values) and dropped.
 * Without a mapping row there is no consent and no event. The row is written
 * inside its own transaction or savepoint, so a failure, a missing partition
 * included, leaves the caller's transaction intact: an event is research
 * data, and a person's action never fails for it.
 */
export type ResearchDeps = { db: Queryable; logger: Logger; now: () => Date };

export type TrackResult =
  | { recorded: true }
  | { recorded: false; reason: "no_consent" | "invalid_props" | "incomplete" | "failed" };

/**
 * Events are timestamped to the hour (UTC). The consent row keeps its exact
 * given_at with the account and survives withdrawal and erasure as proof
 * (ADR-010 §5); an event written at the same instant would share that value
 * and let a database holder rebuild the deleted mapping by joining on it.
 * The hour is coarse enough for every question in the registry (ADR-011 §1).
 */
function hourOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000);
}

/** Whole years from the bank-verified year and month by the Finnish calendar, as the card counts them (rule 3: never a day). */
function ageAt(birthYear: number, birthMonth: number, at: Date): number {
  const now = localYearMonth(at);
  const years = now.year - birthYear;
  return now.month >= birthMonth ? years : years - 1;
}

export async function track<N extends ResearchEventName>(
  deps: ResearchDeps,
  accountId: string,
  name: N,
  props: ResearchEventProps<N>,
): Promise<TrackResult> {
  const spec = RESEARCH_EVENTS[name];
  const parsed = spec.props.safeParse(props);
  if (!parsed.success) {
    deps.logger.error(
      { accountId, event: name, paths: parsed.error.issues.map((i) => i.path.join(".")) },
      "research event refused: props outside the registry",
    );
    return { recorded: false, reason: "invalid_props" };
  }
  try {
    return await transaction(deps.db, async (tx) => {
      const rows = await repo.snapshotRows(tx, accountId);
      if (!rows) return { recorded: false, reason: "no_consent" } as const;
      if (rows.birthYear === null || rows.birthMonth === null) {
        // A live account always has both (rule 3); nothing to band otherwise.
        deps.logger.warn({ accountId, event: name }, "research event dropped: no year and month");
        return { recorded: false, reason: "incomplete" } as const;
      }
      const at = hourOf(deps.now());
      const snapshot: ResearchSnapshot = {
        gender: (rows.gender as Gender | null) ?? null,
        fields: researchFieldsOf(rows.fields),
      };
      await repo.insertEvent(tx, {
        at,
        name,
        researchId: rows.researchId,
        consentVersion: rows.consentVersion,
        pond: rows.pond,
        ageBand: ageBandOf(ageAt(rows.birthYear, rows.birthMonth, at)),
        snapshot,
        props: parsed.data,
      });
      return { recorded: true } as const;
    });
  } catch (err) {
    deps.logger.warn({ err, accountId, event: name }, "research event dropped");
    return { recorded: false, reason: "failed" };
  }
}
