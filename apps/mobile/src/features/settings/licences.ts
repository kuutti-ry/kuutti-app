import LICENSES from "@/generated/licenses.json";
import type { LicenseEntry } from "./license-families";

/**
 * One licence of a package, as scripts/licenses.ts writes it (#416): the
 * file it came from, or null and the upstream address for a package that
 * ships no licence file; its copyright lines; and the key of its text.
 */
type Licence = {
  file: string | null;
  copyright: readonly string[];
  text: string;
  from?: string;
};

type LicencePackage = LicenseEntry & {
  /** Who provides it (#512), or null for a package that names nobody. */
  provider: string | null;
  licences: readonly Licence[];
  /** The keys of its NOTICE files' texts. */
  notices: readonly string[];
};

/** The packages of this build in name order, and each text they name, as its paragraphs. */
export type LicenceList = {
  packages: readonly LicencePackage[];
  texts: Readonly<Record<string, readonly string[]>>;
};

export const LICENCES: LicenceList = LICENSES;

/** Each text the pairs name once, in the order they first name it, with what they put under it. */
function shared<T>(texts: LicenceList["texts"], pairs: ReadonlyArray<readonly [string, T]>) {
  const under = new Map<string, T[]>();
  for (const [key, item] of pairs) under.set(key, [...(under.get(key) ?? []), item]);
  return [...under].map(([key, items]) => ({ key, paragraphs: texts[key] ?? [], items }));
}

/**
 * The texts the list's licences ask to go with every copy (#512), each once:
 * a licence's with the packages under it, a package once for each licence it
 * carries there, with that licence's copyright lines and address; a NOTICE
 * file's with the packages that ship it.
 */
export function licenceTexts({ packages, texts }: LicenceList) {
  return {
    licences: shared(
      texts,
      packages.flatMap(({ name, version, licences }) =>
        licences.map((licence) => [licence.text, { name, version, licence }] as const),
      ),
    ),
    notices: shared(
      texts,
      packages.flatMap(({ name, version, notices }) =>
        notices.map((key) => [key, `${name} ${version}`] as const),
      ),
    ),
  };
}
