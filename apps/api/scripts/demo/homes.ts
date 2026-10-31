import { MATCHING_CONFIG_V1 } from "@kuutti/db";
import { generatePopulation, type HomePlaces } from "@kuutti/db/demo";
import { keptPlace } from "../../src/pond/index.ts";
// biome-ignore lint/style/noRestrictedImports: the list's own rows, read as places.ts reads them: how many people live where is a thing only the demo asks, so the slice's index does not carry it
import { PLACE_AREA_ROWS } from "../../src/pond/places.generated.ts";

/**
 * Where the synthetic population lives (#514, ADR-061 §2): every place a home
 * can be kept in, with the people behind it. What is kept is `keptPlace`'s to
 * say, so a small area's people count for the municipality or the neighbour
 * that keeps them, and the population is spread as the country's people are.
 * Here and not with the generator: the list and the rule are the API's, and
 * packages/db is handed this as it is handed the consents' versions.
 */
export function populationHomes(
  minInhabitants: number = MATCHING_CONFIG_V1.home_min_inhabitants,
): HomePlaces {
  const homes: Record<string, number> = {};
  for (const row of PLACE_AREA_ROWS.split("\n")) {
    const [code = "", , , , inhabitants] = row.split("|");
    const kept = keptPlace(code, minInhabitants);
    if (kept !== null) homes[kept] = (homes[kept] ?? 0) + Number(inhabitants);
  }
  return homes;
}

/** The population a command writes: everybody who onboarded has a home, or the writer refuses them all. */
export const populationWithHomes = (options: { size: number; seed: number }) =>
  generatePopulation({ ...options, homes: populationHomes() });
