import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONSENT_TEXT_HASHES,
  CONSENT_TEXT_LOCALES,
  CONSENT_VERSIONS,
} from "./generated/consent.ts";
import { isLegalTextKind, legalPageUrl } from "./legal.ts";

/**
 * The binding Finnish wording and its version move together (#46, ADR-010
 * §4): an edit to a legal.* text that keeps the version would let every
 * existing consent silently cover the new wording. When this test fails,
 * either bump the consent_version of that kind and update the row here, or
 * revert the text.
 */
const GOLDEN: Record<string, { version: string; hash: string }> = {
  privacy: { version: "2026-10-draft-2", hash: "7197e6c3209d4b4a" },
  research: { version: "2026-09-draft-1", hash: "b55ab7542a8d4bb2" },
  special_category: { version: "2026-10-draft-2", hash: "507c62005dcc9d0d" },
  terms: { version: "2026-09-draft-1", hash: "a947eb54ce1338cd" },
};

describe("consent versions", () => {
  it("names every kind the API requires, in Finnish and English at least", () => {
    for (const kind of ["terms", "privacy", "research", "special_category"]) {
      expect(CONSENT_VERSIONS[kind], kind).toBeTruthy();
      expect(CONSENT_TEXT_LOCALES[kind], kind).toEqual(expect.arrayContaining(["fi", "en"]));
    }
  });

  it("changes the version whenever the binding Finnish wording changes", () => {
    for (const [kind, golden] of Object.entries(GOLDEN)) {
      expect({ version: CONSENT_VERSIONS[kind], hash: CONSENT_TEXT_HASHES[kind] }, kind).toEqual(
        golden,
      );
    }
  });

  // The site's anchors (kuutti-app-site, #208): the research opt-in and the
  // sensitive answers are read on the privacy page.
  it("links each kind to the site's page at the anchor of the version this app carries", () => {
    expect(
      Object.fromEntries(
        Object.entries(CONSENT_VERSIONS).map(([kind, version]) => [
          kind,
          isLegalTextKind(kind) ? legalPageUrl(kind, version) : null,
        ]),
      ),
    ).toEqual({
      privacy: `https://kuutti.app/legal/privacy/#privacy-${CONSENT_VERSIONS.privacy}`,
      research: `https://kuutti.app/legal/privacy/#research-${CONSENT_VERSIONS.research}`,
      special_category: `https://kuutti.app/legal/privacy/#special_category-${CONSENT_VERSIONS.special_category}`,
      terms: `https://kuutti.app/legal/terms/#terms-${CONSENT_VERSIONS.terms}`,
    });
    expect(isLegalTextKind("toString")).toBe(false);
  });

  // The website's CI reads CONSENT_VERSIONS out of this module on main
  // (appVersionsFrom in kuutti-app-site src/lib/consent.ts: this expression,
  // then JSON of what the braces hold without its last comma). A change of
  // the generator's shape fails here first; change the site's reader with it
  // and merge that first, or the site's CI goes red on its next run (#208).
  it("keeps CONSENT_VERSIONS in the shape the website's mirror check reads", () => {
    const source = readFileSync(new URL("./generated/consent.ts", import.meta.url), "utf8");
    const block = /export const CONSENT_VERSIONS\b[^=]*=\s*\{([^}]*)\};/.exec(source);
    expect(block).not.toBeNull();
    expect(JSON.parse(`{${(block?.[1] ?? "").trim().replace(/,$/, "")}}`)).toEqual(
      CONSENT_VERSIONS,
    );
  });
});
