/**
 * Where the full text of each legal wording is read (#208, ADR-010 §4): the
 * website (`kuutti-ry/kuutti-app-site`) holds it under the same version as
 * the app's summary, at an anchor named by the kind and the version. The
 * site's build publishes the address of each in /legal/versions.json, and
 * the app's CI holds this address to it (`pnpm check:legal-versions`), so a
 * link from the app never names a version the site does not have. A link to
 * the public site, not a web surface of the product (CLAUDE.md rule 8).
 */
export const LEGAL_SITE = "https://kuutti.app";

/** The page each kind is read on: the research opt-in and the sensitive answers are on the privacy page. */
const PAGE = {
  terms: "terms",
  privacy: "privacy",
  research: "privacy",
  special_category: "privacy",
} as const;

export type LegalTextKind = keyof typeof PAGE;

export const isLegalTextKind = (kind: string): kind is LegalTextKind => Object.hasOwn(PAGE, kind);

/** The full text of a kind at the anchor of a version: `https://kuutti.app/legal/privacy/#research-2026-09-draft-1`. */
export function legalPageUrl(kind: LegalTextKind, version: string): string {
  return `${LEGAL_SITE}/legal/${PAGE[kind]}/#${kind}-${version}`;
}
