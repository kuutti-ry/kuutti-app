import { type Queryable, transaction } from "@kuutti/db";
import type { Locale } from "@kuutti/i18n";
import type { AccountExport, HomeSummary, HomeUpdate, PlaceName } from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import { readMatchingConfig } from "../lib/matching-config.ts";
import { areaOf, homeRules, homeSummary, keptPlace, nameOf, shownPlace, townOf } from "./places.ts";
import * as repo from "./repo.ts";

/**
 * A person's one home (#514, ADR-061). The digits come in through the body of
 * `PUT /account/home`, are looked up in memory and never enter a statement but
 * as the key of an area large enough to keep; an unknown code is refused by a
 * constant, with no detail. Nothing here logs more than the account (§9): a
 * home is in no log line, error, event, frame or push.
 */
export type HomeDeps = { db: Queryable; logger: Logger; now?: () => Date };

/** The matching_config key naming the one pond (ADR-061 §8). */
const DEFAULT_POND_KEY = "default_pond";

/**
 * A new home, what the card shows, or both. A new postal code starts from the
 * town again unless the same request says otherwise (§3), and a choice with
 * no area to show stays false. It changes whenever the person likes, with no
 * cadence, and the earlier home is overwritten (§1, §9); the time of the move
 * closes the day's short pool (§5). A pond held stays.
 */
export async function saveHome(
  deps: HomeDeps,
  accountId: string,
  update: HomeUpdate,
): Promise<HomeSummary> {
  const rules = await homeRules(deps.db);
  const { postalCode } = update;
  const moved = postalCode === undefined ? null : keptPlace(postalCode, rules.minInhabitants);
  if (postalCode !== undefined && moved === null) {
    throw new AppError(400, "postal_code_unknown", "That postal code is not on the list");
  }
  const slug = await readMatchingConfig(deps.db, DEFAULT_POND_KEY);
  const home = await transaction(deps.db, async (tx) => {
    const stored = await repo.lockHomeOfAccount(tx, accountId);
    if (!stored) throw new AppError(404, "not_found", "No live account");
    const place =
      moved ?? (stored.place === null ? null : keptPlace(stored.place, rules.minInhabitants));
    if (place === null) throw new AppError(400, "validation_failed", "A postal code first");
    const area = areaOf(place);
    const showArea = update.showArea === true && area !== null;
    const pond = await repo.writeHomeOfAccount(
      tx,
      accountId,
      { place: moved, showsArea: showArea },
      typeof slug === "string" ? slug : null,
      deps.now?.() ?? new Date(),
    );
    // Thrown as a fault, not refused: nobody is left with a home and no pond,
    // which would read as `incomplete` for ever with nothing to say why, and
    // this goes to Sentry. The transaction takes the home back with it.
    if (pond === null) throw new Error("saveHome: matching_config default_pond names no pond");
    return { town: townOf(place, rules.townMin), area, showArea };
  });
  deps.logger.info({ accountId }, "home set");
  return home;
}

/**
 * The person's own home in names, null without one. A kept place the list no
 * longer knows reads as no home, which opens the step again (§2); the warn
 * line says it happened and names no key.
 */
export async function readHome(deps: HomeDeps, accountId: string): Promise<HomeSummary | null> {
  const stored = await repo.findHomeOfAccount(deps.db, accountId);
  if (!stored?.place) return null;
  const home = homeSummary(stored.place, stored.showsArea, await homeRules(deps.db));
  if (!home) deps.logger.warn({ accountId }, "home reads as none");
  return home;
}

/** English reads Finnish, and no sentence is built around a name (ADR-061 §3, TD-17). */
const inLanguage = (name: PlaceName, locale: Locale): string =>
  locale === "sv" ? name.sv : name.fi;

/**
 * The export (§9): the place held and the name the card shows, in words,
 * never a key, and when it last moved. Null as `readHome` reads none.
 */
export async function exportHome(
  db: Queryable,
  accountId: string,
  locale: Locale,
): Promise<AccountExport["account"]["home"]> {
  const stored = await repo.findHomeOfAccount(db, accountId);
  if (!stored?.place) return null;
  const rules = await homeRules(db);
  const kept = keptPlace(stored.place, rules.minInhabitants);
  const home = homeSummary(kept, stored.showsArea, rules);
  if (kept === null || !home) return null;
  return {
    place: inLanguage(nameOf(kept), locale),
    shownOnCard: inLanguage(shownPlace(home), locale),
    movedAt: stored.movedAt?.toISOString() ?? null,
  };
}
