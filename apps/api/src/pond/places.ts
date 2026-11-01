import type { Queryable } from "@kuutti/db";
import type { HomeSummary, PlaceName } from "@kuutti/schema";
import { POSTAL_CODE_LENGTH, postalMatches } from "@kuutti/schema/postal-areas";
import { matchingConfigNumbers } from "../lib/matching-config.ts";
import { PLACE_AREA_ROWS, PLACE_MUNICIPALITY_ROWS } from "./places.generated.ts";

/**
 * Where a person's home is, over the list `pnpm places` writes (ADR-061 §2 to
 * §4). A place's key is an official code: five digits for a postal area, three
 * for a municipality. Nothing here reaches the database but homeRules, so that
 * a code is looked up in memory, and only the key of a place large enough to
 * keep is ever written (§9).
 */

type Point = { x: number; y: number };
type Area = Point & { municipality: string; inhabitants: number };
type Municipality = Point & {
  code: string;
  name: PlaceName;
  inhabitants: number;
  town: boolean;
  aland: boolean;
};

/** The two numbers a home is read by: `home_min_inhabitants` and `home_town_min_inhabitants`. */
export type HomeRules = { minInhabitants: number; townMin: number };

/** Åland's postal codes begin so, and no other's do: the list itself says who is across the sea. */
const ALAND_CODES = "22";

const AREAS = new Map<string, Area>();
for (const row of PLACE_AREA_ROWS.split("\n")) {
  const [code = "", municipality = "", x, y, inhabitants] = row.split("|");
  AREAS.set(code, { municipality, x: Number(x), y: Number(y), inhabitants: Number(inhabitants) });
}

/** Each municipality's areas, the smallest first: the order they go back in (§2). */
const AREAS_OF = new Map<string, { code: string; inhabitants: number }[]>();
for (const [code, { municipality, inhabitants }] of AREAS) {
  AREAS_OF.set(municipality, [...(AREAS_OF.get(municipality) ?? []), { code, inhabitants }]);
}
for (const areas of AREAS_OF.values()) areas.sort((a, b) => a.inhabitants - b.inhabitants);

const ALAND = new Set(
  [...AREAS].filter(([code]) => code.startsWith(ALAND_CODES)).map(([, area]) => area.municipality),
);

const MUNICIPALITIES = new Map<string, Municipality>();
for (const row of PLACE_MUNICIPALITY_ROWS.split("\n")) {
  const [code = "", fi = "", sv, x, y, inhabitants, town] = row.split("|");
  MUNICIPALITIES.set(code, {
    code,
    name: { fi, sv: sv || fi },
    x: Number(x),
    y: Number(y),
    inhabitants: Number(inhabitants),
    town: town === "1",
    aland: ALAND.has(code),
  });
}

/** The municipality of a place's key, itself where the key is one; undefined for a key the list lacks. */
function municipalityOf(key: string): Municipality | undefined {
  return MUNICIPALITIES.get(AREAS.get(key)?.municipality ?? key);
}

/** The municipality that qualifies nearest to a point, by centre; a tie goes to the lower code. */
function nearest(
  from: Point,
  qualifies: (municipality: Municipality) => boolean,
): Municipality | undefined {
  let found: Municipality | undefined;
  let shortest = Number.POSITIVE_INFINITY;
  for (const municipality of MUNICIPALITIES.values()) {
    const squared = (municipality.x - from.x) ** 2 + (municipality.y - from.y) ** 2;
    if (squared < shortest && qualifies(municipality)) {
      found = municipality;
      shortest = squared;
    }
  }
  return found;
}

/**
 * The municipality a place under the floor belongs to (ADR-061 §2): its own if
 * that has `minInhabitants` people, else the nearest that has, on its own side
 * of the sea while that side has one (§3).
 */
function fallsTo(own: Municipality, minInhabitants: number): Municipality | undefined {
  const enough = (other: Municipality) => other.inhabitants >= minInhabitants;
  if (enough(own)) return own;
  return (
    nearest(own, (other) => other.aland === own.aland && enough(other)) ?? nearest(own, enough)
  );
}

type Kept = {
  floor: number;
  /** The postal areas that keep their own key. */
  areas: ReadonlySet<string>;
  /** Each municipality's code to the key it falls to; absent under a floor no municipality reaches. */
  municipalities: ReadonlyMap<string, string>;
};

let held: Kept | undefined;

/**
 * Who keeps what under a floor (ADR-061 §2). An area of `minInhabitants` people
 * takes them out from behind its municipality's key, and those left there, with
 * the small municipalities that fall to it, can be too few: in Aura, one small
 * area under another name. So the smallest large areas go back in until enough
 * are, and every key stands for at least the floor. Every read of a home asks,
 * so the answer for the floor in force is held.
 */
function keptUnder(minInhabitants: number): Kept {
  if (held?.floor === minInhabitants) return held;
  const municipalities = new Map<string, string>();
  const behind = new Map<string, number>();
  for (const own of MUNICIPALITIES.values()) {
    const key = fallsTo(own, minInhabitants)?.code;
    if (!key) continue;
    municipalities.set(own.code, key);
    const small = AREAS_OF.get(own.code)?.filter((area) => area.inhabitants < minInhabitants) ?? [];
    const people = small.reduce((sum, area) => sum + Math.max(0, area.inhabitants), 0);
    behind.set(key, (behind.get(key) ?? 0) + people);
  }
  const areas = new Set<string>();
  for (const [municipality, own] of AREAS_OF) {
    let people = behind.get(municipality) ?? 0;
    for (const area of own.filter((area) => area.inhabitants >= minInhabitants)) {
      if (people > 0 && people < minInhabitants) people += area.inhabitants;
      else areas.add(area.code);
    }
  }
  held = { floor: minInhabitants, areas, municipalities };
  return held;
}

/**
 * What is kept of a postal code or a stored key (ADR-061 §2): the postal area
 * if it has `minInhabitants` people and enough are left behind its
 * municipality's key without it, else the municipality, else the nearest
 * municipality that has. Null for what the list lacks, and for a floor no
 * municipality reaches: nothing is ever kept below it. Stored keys are read
 * through it too, so a raised floor coarsens every read at once. A lowered one
 * gives back only what the row still holds: a municipality's key has no digits
 * to go back to.
 */
export function keptPlace(codeOrKey: string, minInhabitants: number): string | null {
  const kept = keptUnder(minInhabitants);
  if (kept.areas.has(codeOrKey)) return codeOrKey;
  const own = municipalityOf(codeOrKey);
  return (own && kept.municipalities.get(own.code)) ?? null;
}

/** A place's centre in ETRS-TM35FIN metres, for the straight line between two homes (ADR-061 §5). */
export function pointOf(key: string): Point | null {
  const place = AREAS.get(key) ?? MUNICIPALITIES.get(key);
  return place ? { x: place.x, y: place.y } : null;
}

/**
 * The town a card shows by default (ADR-061 §3): the place's municipality if
 * it counts as a town, else the one nearest the place's own centre that does.
 * Takes a key keptPlace gave; a key the list lacks has no town, which is a
 * caller's bug and says so without naming the key.
 */
export function townOf(key: string, townMin: number): PlaceName {
  const own = municipalityOf(key);
  if (!own) throw new Error("townOf: a place that is not on the list");
  const isTown = (municipality: Municipality) =>
    municipality.town || municipality.inhabitants >= townMin;
  if (isTown(own)) return own.name;
  // Maarianhamina counts at any size, so there is always one.
  return (nearest(AREAS.get(key) ?? own, isTown) as Municipality).name;
}

/** The area's names where an area is kept; a municipality has none, and neither has a key the list lacks. */
export function areaOf(key: string): PlaceName | null {
  const [area] = key.length === POSTAL_CODE_LENGTH ? postalMatches(key, 1) : [];
  return area ? { fi: area.fi, sv: area.sv } : null;
}

/**
 * What a kept place is called itself (ADR-061 §9): the area's name, else the
 * municipality's, which a card may never say where the town is another. What
 * the export says is held. Takes a key keptPlace gave, as townOf does.
 */
export function nameOf(key: string): PlaceName {
  const name = areaOf(key) ?? municipalityOf(key)?.name;
  if (!name) throw new Error("nameOf: a place that is not on the list");
  return name;
}

/**
 * A home as its owner reads it (ADR-061 §3). Null without one, and for a key
 * the list no longer knows, which reads as no home and opens the step again
 * (§2). `showArea` stays false where no area is kept: the area's name is the
 * only thing the switch can show.
 */
export function homeSummary(
  key: string | null,
  showArea: boolean,
  rules: HomeRules,
): HomeSummary | null {
  const kept = key === null ? null : keptPlace(key, rules.minInhabitants);
  if (kept === null) return null;
  const area = areaOf(kept);
  return { town: townOf(kept, rules.townMin), area, showArea: showArea && area !== null };
}

/** The one name a card says of a home (ADR-061 §3): the area where the person chose it, else the town. */
export function shownPlace(home: HomeSummary): PlaceName {
  return home.showArea && home.area ? home.area : home.town;
}

export async function homeRules(db: Queryable): Promise<HomeRules> {
  const numbers = await matchingConfigNumbers(db, [
    "home_min_inhabitants",
    "home_town_min_inhabitants",
  ]);
  return {
    minInhabitants: numbers.home_min_inhabitants,
    townMin: numbers.home_town_min_inhabitants,
  };
}
