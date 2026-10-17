import { describe, expect, it, vi } from "vitest";
import {
  fetchPublished,
  legalVersionProblems,
  type Published,
  parsePublished,
  siteFingerprint,
  VERSIONS_URL,
} from "./legal-versions.ts";

// The app's half of #208: its CONSENT_VERSIONS against the site's
// /legal/versions.json. No network: every fetch here is a stand-in.

const APP = {
  privacy: "2026-09-draft-1",
  research: "2026-09-draft-1",
  special_category: "2026-10-draft-2",
  terms: "2026-09-draft-1",
};

/** The Finnish wordings the site carries as the app has them (stand-ins). */
const FI = {
  "legal.research.title": "Tutkimus",
  "legal.research.summary": "LUONNOS: tutkimus.",
  "legal.special_category.title": "Arkaluonteiset tiedot",
  "legal.special_category.summary": "LUONNOS: arkaluonteiset vastaukset.",
};

/** The document as the site's build writes it, its own fields included. */
const SITE = {
  terms: {
    version: "2026-09-draft-1",
    hash: "65b7fa7d00ed9290",
    language: "en",
    url: "https://kuutti.app/legal/terms/#terms-2026-09-draft-1",
    dated: "2026-10-01",
  },
  privacy: {
    version: "2026-09-draft-1",
    hash: "422ac16a1df3d859",
    language: "en",
    url: "https://kuutti.app/legal/privacy/#privacy-2026-09-draft-1",
    dated: "2026-10-06",
  },
  research: {
    version: "2026-09-draft-1",
    hash: siteFingerprint("Tutkimus", "LUONNOS: tutkimus."),
    language: "fi",
    url: "https://kuutti.app/legal/privacy/#research-2026-09-draft-1",
    dated: "2026-09-26",
  },
  special_category: {
    version: "2026-10-draft-2",
    hash: siteFingerprint("Arkaluonteiset tiedot", "LUONNOS: arkaluonteiset vastaukset."),
    language: "fi",
    url: "https://kuutti.app/legal/privacy/#special_category-2026-10-draft-2",
    dated: "2026-10-08",
  },
};
const published = (): Published => parsePublished(JSON.stringify(SITE));

describe("siteFingerprint", () => {
  it("is the site's: the same pair gives the value the site's test holds (scripts/consent.test.ts there)", () => {
    expect(siteFingerprint(" Tutkimus ", "LUONNOS: teksti.\r\n")).toBe("3db7397d9d6d2d5c");
    expect(siteFingerprint("Tutkimus", "LUONNOS: teksti.")).toBe("3db7397d9d6d2d5c");
    expect(siteFingerprint("Tutkimus", "LUONNOS: teksti!")).not.toBe("3db7397d9d6d2d5c");
    expect(siteFingerprint("Tutkimussuostumus", "LUONNOS: teksti.")).not.toBe("3db7397d9d6d2d5c");
  });
});

describe("parsePublished", () => {
  it("reads the version, the address and the fingerprint of each kind and leaves the day", () => {
    expect(published().research).toEqual({
      version: "2026-09-draft-1",
      hash: SITE.research.hash,
      language: "fi",
      url: "https://kuutti.app/legal/privacy/#research-2026-09-draft-1",
    });
  });

  const entry = (fields: Record<string, unknown>) =>
    JSON.stringify({
      terms: { version: "1", hash: "0123456789abcdef", language: "en", url: "u", ...fields },
    });
  it.each<[string, string, RegExp]>([
    ["not JSON", "<html>Not found</html>", /^is not JSON$/],
    ["an array", "[]", /is not a versions document: \(the document\): /],
    ["a kind without a version", entry({ version: undefined }), /terms\.version: /],
    ["an empty version", entry({ version: "" }), /terms\.version: /],
    ["a kind without an address", entry({ url: undefined }), /terms\.url: /],
    ["a kind without a fingerprint", entry({ hash: undefined }), /terms\.hash: /],
    ["a fingerprint that is not 16 hex digits", entry({ hash: "0123" }), /terms\.hash: /],
    ["a kind without the language of its text", entry({ language: "" }), /terms\.language: /],
    ["a kind that is not an object", '{"terms":"2026-09-draft-1"}', /terms: /],
  ])("refuses %s", (_, text, message) => {
    expect(() => parsePublished(text)).toThrow(message);
  });
});

describe("fetchPublished", () => {
  it("asks the deployed site for JSON, with a time limit, and reads the answer", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(SITE)));
    await expect(fetchPublished(fetchImpl)).resolves.toEqual(published());
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://kuutti.app/legal/versions.json",
      expect.objectContaining({
        headers: { accept: "application/json" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(VERSIONS_URL).toBe("https://kuutti.app/legal/versions.json");
  });

  it("fails on a 404, so a site that has not published the file is never a pass", async () => {
    const fetchImpl = async () => new Response("Not found", { status: 404 });
    await expect(fetchPublished(fetchImpl, "https://site.test/v.json")).rejects.toThrow(
      "https://site.test/v.json answered 404",
    );
  });

  it("fails on an answer that is not the document, naming the address", async () => {
    const fetchImpl = async () => new Response("<html></html>", { status: 200 });
    await expect(fetchPublished(fetchImpl, "https://site.test/v.json")).rejects.toThrow(
      "https://site.test/v.json is not JSON",
    );
  });

  // A stand-in for the pause between tries: no clock, the pauses recorded.
  const paused = () => {
    const pauses: number[] = [];
    return { pauses, pause: async (ms: number) => void pauses.push(ms) };
  };
  const answers = (...steps: (number | Error)[]) =>
    vi.fn(async () => {
      const step = steps.shift();
      if (step === undefined) throw new Error("asked once too often");
      if (step instanceof Error) throw step;
      return new Response(step === 200 ? JSON.stringify(SITE) : "Busy", { status: step });
    });

  it("tries again after a network failure and a 5xx, the pauses growing, and reads the third answer", async () => {
    const { pauses, pause } = paused();
    const fetchImpl = answers(new TypeError("fetch failed"), 503, 200);
    await expect(fetchPublished(fetchImpl, VERSIONS_URL, pause)).resolves.toEqual(published());
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(pauses).toEqual([5_000, 10_000]);
  });

  it("passes on the third network failure as it came", async () => {
    const { pauses, pause } = paused();
    const failed = new TypeError("fetch failed");
    const fetchImpl = answers(failed, failed, failed);
    await expect(fetchPublished(fetchImpl, VERSIONS_URL, pause)).rejects.toThrow("fetch failed");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(pauses).toEqual([5_000, 10_000]);
  });

  it("fails on the third 5xx with its status", async () => {
    const { pause } = paused();
    const fetchImpl = answers(502, 502, 502);
    await expect(fetchPublished(fetchImpl, "https://site.test/v.json", pause)).rejects.toThrow(
      "https://site.test/v.json answered 502",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("pauses on the clock by default, five seconds after the first failure", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = answers(new TypeError("fetch failed"), 200);
      const reading = fetchPublished(fetchImpl);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(reading).resolves.toEqual(published());
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not try a 4xx again", async () => {
    const { pauses, pause } = paused();
    const fetchImpl = answers(404);
    await expect(fetchPublished(fetchImpl, VERSIONS_URL, pause)).rejects.toThrow("answered 404");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(pauses).toEqual([]);
  });
});

describe("legalVersionProblems", () => {
  it("finds nothing when every kind has the site's version and the site's address", () => {
    expect(legalVersionProblems(APP, published(), FI)).toEqual([]);
  });

  it("fails when the site published a new version the app does not carry yet", () => {
    const site = published();
    site.privacy = {
      ...SITE.privacy,
      version: "2026-11-1",
      url: "https://kuutti.app/legal/privacy/#privacy-2026-11-1",
    };
    expect(legalVersionProblems(APP, site, FI)).toEqual([
      expect.stringMatching(
        /^privacy: the app carries 2026-09-draft-1, the site publishes 2026-11-1 \(https:\/\/kuutti\.app\/legal\/privacy\/#privacy-2026-11-1\)\. The site's text leads/,
      ),
    ]);
  });

  it("fails when the app moved a version the site has not published", () => {
    expect(legalVersionProblems({ ...APP, terms: "2026-11-1" }, published(), FI)).toEqual([
      expect.stringMatching(
        /^terms: the app carries 2026-11-1, the site publishes 2026-09-draft-1/,
      ),
    ]);
  });

  it("fails on a kind either side lacks", () => {
    const { research: _, ...withoutResearch } = SITE;
    expect(legalVersionProblems(APP, parsePublished(JSON.stringify(withoutResearch)), FI)).toEqual([
      "research: the site publishes no version of it (the app carries 2026-09-draft-1)",
    ]);
    const { research: __, ...appWithout } = APP;
    expect(legalVersionProblems(appWithout, published(), FI)).toEqual([
      "research: the site publishes a version of a kind the app does not know",
    ]);
  });

  it("fails when the app's link is not the address the site publishes for the version", () => {
    const site = published();
    site.terms = {
      ...SITE.terms,
      version: "2026-09-draft-1",
      url: "https://kuutti.app/fi/legal/terms/#terms-2026-09-draft-1",
    };
    expect(legalVersionProblems(APP, site, FI)).toEqual([
      "terms: the app links to https://kuutti.app/legal/terms/#terms-2026-09-draft-1, the site publishes the text at https://kuutti.app/fi/legal/terms/#terms-2026-09-draft-1",
    ]);
  });

  it("fails on a kind both carry that the app has no page for", () => {
    const police = { ...SITE.terms, version: "1", url: "https://kuutti.app/x" };
    const site = { ...published(), police };
    expect(legalVersionProblems({ ...APP, police: "1" }, site, FI)).toEqual([
      "police: the app has no page for it to link to (src/legal.ts)",
    ]);
  });

  it("fails when the site's research text is not this app's Finnish wording, under the same version", () => {
    // The site bumped the version with its old text, or edited its text in
    // place, or the app's summary moved: either way two texts, one version.
    const site = published();
    site.research = { ...SITE.research, hash: "72a206b59f5659c5" };
    expect(legalVersionProblems(APP, site, FI)).toEqual([
      `research: the site's text of 2026-09-draft-1 (fi, 72a206b59f5659c5) is not this app's Finnish legal.research.title and summary (fi, ${SITE.research.hash}). The site carries this wording as the app has it, so one of the two changed without the other: one version, one text`,
    ]);
    const retitled = { ...FI, "legal.special_category.title": "Erityiset tiedot" };
    expect(legalVersionProblems(APP, published(), retitled)).toEqual([
      expect.stringMatching(/^special_category: the site's text of 2026-10-draft-2 \(fi, /),
    ]);
  });

  it("fails when the site's research text is not the Finnish one, and holds no fingerprint of the terms or the privacy policy", () => {
    const site = published();
    site.special_category = { ...SITE.special_category, language: "en" };
    expect(legalVersionProblems(APP, site, FI)).toEqual([
      expect.stringMatching(/^special_category: the site's text of 2026-10-draft-2 \(en, /),
    ]);
    // The terms and the privacy policy: the site's full text, the app's summary.
    const full = published();
    full.terms = { ...SITE.terms, hash: "0123456789abcdef", language: "fi" };
    expect(legalVersionProblems(APP, full, FI)).toEqual([]);
  });

  it("reports a wrong link and a parted wording of one kind together", () => {
    const site = published();
    site.research = {
      ...SITE.research,
      hash: "72a206b59f5659c5",
      url: "https://kuutti.app/legal/research/",
    };
    expect(legalVersionProblems(APP, site, FI)).toEqual([
      expect.stringMatching(/^research: the app links to /),
      expect.stringMatching(/^research: the site's text of /),
    ]);
  });
});
