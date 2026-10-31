import type { PlainMessageKey } from "@kuutti/i18n";
import type { PondSummary } from "@kuutti/schema";

/**
 * A pond's name in the person's language (#174, ADR-010 §12): the catalogue
 * carries the one pond there is (`pond.name.<slug>`, ADR-061 §8), and a pond
 * it does not know keeps the Finnish name the API sends. Always the nominative:
 * no sentence is built around it (TD-17), so no case form is needed here.
 */
const POND_NAME_KEYS: Readonly<Record<string, PlainMessageKey>> = {
  suomi: "pond.name.suomi",
};

export function pondName(
  t: (key: PlainMessageKey) => string,
  pond: Pick<PondSummary, "slug" | "name">,
): string {
  const key = POND_NAME_KEYS[pond.slug];
  return key ? t(key) : pond.name;
}
