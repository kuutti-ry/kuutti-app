import { describe, expect, it } from "vitest";
import {
  CONSENT_TEXT_HASHES,
  CONSENT_TEXT_LOCALES,
  CONSENT_VERSIONS,
} from "./generated/consent.ts";

/**
 * The binding Finnish wording and its version move together (#46, ADR-010
 * §4): an edit to a legal.* text that keeps the version would let every
 * existing consent silently cover the new wording. When this test fails,
 * either bump the consent_version of that kind and update the row here, or
 * revert the text.
 */
const GOLDEN: Record<string, { version: string; hash: string }> = {
  privacy: { version: "2026-09-draft-1", hash: "7197e6c3209d4b4a" },
  research: { version: "2026-09-draft-1", hash: "b55ab7542a8d4bb2" },
  special_category: { version: "2026-10-draft-1", hash: "16dacb97fe8344b1" },
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
});
