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
