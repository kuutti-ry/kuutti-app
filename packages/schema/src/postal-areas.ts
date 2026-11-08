import { POSTAL_AREA_ROWS } from "./postal-areas.generated.ts";

/**
 * The postal areas of Finland for the phone's autocomplete (ADR-061 §4), so
 * that a half-typed home never reaches the server. Behind its own subpath,
 * never the package root: Metro does not tree-shake here, and the list would
 * travel with every import of this package.
 */

export { POSTAL_AREAS_CREDIT } from "./postal-areas.generated.ts";

export const POSTAL_CODE_LENGTH = 5;

/** A code stays a string, so that 00100 keeps its zeros; `sv` repeats `fi` where the two are one name. */
export type PostalMatch = { code: string; fi: string; sv: string };

let parsed: PostalMatch[] | undefined;

/** Split on the first search: the string is cheap to carry, the rows are not. */
function rows(): PostalMatch[] {
  parsed ??= POSTAL_AREA_ROWS.split("\n").map((row) => {
    const [code = "", fi = "", sv = ""] = row.split("|");
    return { code, fi, sv: sv || fi };
  });
  return parsed;
}

/** At most `limit` rows whose code starts with `digits`, by code; nothing typed offers nothing. */
export function postalMatches(digits: string, limit: number): PostalMatch[] {
  if (digits === "") return [];
  const matches: PostalMatch[] = [];
  for (const row of rows()) {
    if (matches.length >= limit) break;
    if (row.code.startsWith(digits)) matches.push(row);
  }
  return matches;
}
