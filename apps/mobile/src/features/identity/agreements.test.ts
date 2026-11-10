import { CONSENT_VERSIONS } from "@kuutti/i18n";
import * as SecureStore from "expo-secure-store";
import {
  type Agreements,
  agreedOnThisPhone,
  agreementsOf,
  bindAgreements,
  dropAgreements,
  dropUnboundAgreements,
  giveAgreements,
  heldAgreements,
  holdAgreements,
  recordAgreements,
  rememberAgreed,
  takeAgreements,
} from "./agreements";

// What a person answered before the bank login (#418, ADR-010 §15): the
// answers wait in memory for the exchange, become rows through POST /consents
// right after it, and the phone remembers the versions once the terms and the
// privacy summary have landed.

const { __store: store } = jest.requireMock("expo-secure-store") as {
  __store: Map<string, string>;
};
const AGREED = "kuutti.preference.agreedVersions";
const TERMS = String(CONSENT_VERSIONS.terms);
const PRIVACY = String(CONSENT_VERSIONS.privacy);
const RESEARCH = String(CONSENT_VERSIONS.research);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
/** The API's answer to a consent given: the rows and the versions it holds now. */
const consents = () =>
  json({
    consents: [],
    currentVersions: {
      terms: TERMS,
      privacy: PRIVACY,
      research: RESEARCH,
      special_category: String(CONSENT_VERSIONS.special_category),
    },
  });

type Posted = { kind: string; version: string; locale: string };
const routes: string[] = [];
/**
 * POST /consents answered per kind: a Response, or a thrown network failure.
 * Every route called is kept, and afterEach holds them to that one: an
 * assertion inside the mock would be swallowed with the post.
 */
function serve(answers: Partial<Record<string, () => Response>> = {}) {
  const posted: Posted[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    routes.push(`${request.method} ${new URL(request.url).pathname}`);
    const body = (await request.json()) as Posted;
    posted.push(body);
    const answer = answers[body.kind];
    return answer ? answer() : consents();
  }) as unknown as typeof fetch;
  return posted;
}
const networkDown = () => {
  throw new TypeError("Network request failed");
};

const answers: Agreements = { terms: TERMS, privacy: PRIVACY, locale: "sv" };
const later: Agreements = { ...answers, locale: "fi" };

beforeEach(() => {
  dropAgreements();
  store.delete(AGREED);
  routes.length = 0;
});
afterEach(() => {
  jest.restoreAllMocks();
  expect(routes.filter((route) => route !== "POST /consents")).toEqual([]);
});

describe("agreementsOf", () => {
  it("names the versions this app carries of the terms and the privacy summary, and nothing of research", () => {
    expect(agreementsOf("en")).toEqual({ terms: TERMS, privacy: PRIVACY, locale: "en" });
  });

  it.each([
    ["fi", "fi"],
    ["sv", "sv"],
    ["en", "en"],
    // Stadi reads the Finnish texts.
    ["fi-x-stadi", "fi"],
    // The pseudo-locale reads the English texts, and so does anything unknown.
    ["en-XA", "en"],
    ["de", "en"],
    ["", "en"],
  ])("names the texts shown in %j as %s", (locale, shown) => {
    expect(agreementsOf(locale).locale).toBe(shown);
  });

  it("names a wording this build carries no version of as empty, which the API refuses", () => {
    jest.isolateModules(() => {
      jest.doMock("@kuutti/i18n", () => ({
        ...jest.requireActual("@kuutti/i18n"),
        CONSENT_VERSIONS: {},
      }));
      const bare = require("./agreements") as typeof import("./agreements");
      expect(bare.agreementsOf("fi")).toEqual({ terms: "", privacy: "", locale: "fi" });
    });
    jest.dontMock("@kuutti/i18n");
  });
});

describe("the held answers", () => {
  const A = "attempt-a";
  const B = "attempt-b";

  it("hold nothing until answers are given", () => {
    expect(heldAgreements()).toBeNull();
    expect(takeAgreements(A)).toBeNull();
    expect(bindAgreements(A)).toBe(false);
  });

  it("are read as often as asked, and taken once by the attempt they were carried into", () => {
    holdAgreements(answers);
    expect(heldAgreements()).toEqual(answers);
    expect(heldAgreements()).toEqual(answers);
    expect(bindAgreements(A)).toBe(true);
    expect(takeAgreements(A)).toEqual(answers);
    expect(takeAgreements(A)).toBeNull();
    expect(heldAgreements()).toBeNull();
  });

  it("are the last answers given when given twice", () => {
    holdAgreements(answers);
    holdAgreements(later);
    bindAgreements(A);
    expect(takeAgreements(A)).toEqual(later);
  });

  it("go to no exchange before they were carried into an attempt, and are gone after it asks", () => {
    holdAgreements(answers);
    expect(takeAgreements(A)).toBeNull();
    expect(heldAgreements()).toBeNull();
  });

  it("go to no other attempt's exchange, and are gone after it asks", () => {
    holdAgreements(answers);
    bindAgreements(A);
    expect(takeAgreements(B)).toBeNull();
    expect(takeAgreements(A)).toBeNull();
  });

  it("stay with their attempt when it is opened again, and are dropped when another one starts", () => {
    holdAgreements(answers);
    expect(bindAgreements(A)).toBe(true);
    expect(bindAgreements(A)).toBe(true);
    expect(bindAgreements(B)).toBe(false);
    expect(heldAgreements()).toBeNull();
  });

  it("are gone once a refusal drops them", () => {
    holdAgreements(answers);
    dropAgreements();
    expect(heldAgreements()).toBeNull();
  });

  it("are dropped when the app leaves before they were carried to the bank, and kept after", () => {
    expect(dropUnboundAgreements()).toBe(false);
    holdAgreements(answers);
    expect(dropUnboundAgreements()).toBe(true);
    expect(heldAgreements()).toBeNull();
    holdAgreements(answers);
    bindAgreements(A);
    expect(dropUnboundAgreements()).toBe(false);
    expect(takeAgreements(A)).toEqual(answers);
  });

  it.each([
    ["ten minutes after", 10 * 60 * 1000, true],
    ["a moment past ten minutes", 10 * 60 * 1000 + 1, false],
    ["with the clock set back", -1, false],
  ])("wait for their exchange %s: %p", (_when, after, kept) => {
    const now = jest.spyOn(Date, "now").mockReturnValue(5_000_000);
    holdAgreements(answers);
    expect(bindAgreements(A)).toBe(true);
    now.mockReturnValue(5_000_000 + after);
    expect(heldAgreements()).toEqual(kept ? answers : null);
    expect(takeAgreements(A)).toEqual(kept ? answers : null);
    now.mockRestore();
  });

  it("count the ten minutes from the attempt, not from the answer", () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(5_000_000);
    holdAgreements(answers);
    bindAgreements(A, 5_000_000 + 9 * 60 * 1000);
    now.mockReturnValue(5_000_000 + 18 * 60 * 1000);
    expect(takeAgreements(A)).toEqual(answers);
    now.mockRestore();
  });
});

describe("agreedOnThisPhone", () => {
  it("is false on a phone that never recorded anything", async () => {
    expect(await agreedOnThisPhone()).toBe(false);
  });

  it("is true once the current versions are remembered, as rememberAgreed writes them", async () => {
    await rememberAgreed();
    expect(JSON.parse(String(store.get(AGREED)))).toEqual({ terms: TERMS, privacy: PRIVACY });
    expect(await agreedOnThisPhone()).toBe(true);
  });

  it("ignores what else the stored answer carries", async () => {
    store.set(AGREED, JSON.stringify({ terms: TERMS, privacy: PRIVACY, research: "x" }));
    expect(await agreedOnThisPhone()).toBe(true);
  });

  it.each([
    ["an older terms wording", JSON.stringify({ terms: "2025-01-draft-1", privacy: PRIVACY })],
    ["an older privacy wording", JSON.stringify({ terms: TERMS, privacy: "2025-01-draft-1" })],
    ["the terms alone", JSON.stringify({ terms: TERMS })],
    ["the privacy summary alone", JSON.stringify({ privacy: PRIVACY })],
    ["the two swapped for numbers", JSON.stringify({ terms: 1, privacy: 2 })],
    ["an empty object", "{}"],
    ["JSON null", "null"],
    ["a number", "42"],
    ["a string", JSON.stringify(TERMS)],
    ["an array", JSON.stringify([TERMS, PRIVACY])],
    ["text that is not JSON", "not json"],
    ["an empty string", ""],
  ])("is false for %s", async (_what, stored) => {
    store.set(AGREED, stored);
    expect(await agreedOnThisPhone()).toBe(false);
  });

  it("is false when the store cannot be read, as a preference never set", async () => {
    (SecureStore.getItemAsync as jest.Mock).mockRejectedValueOnce(new Error("keychain locked"));
    expect(await agreedOnThisPhone()).toBe(false);
  });
});

describe("recordAgreements", () => {
  it("posts the terms, then the privacy summary, in the language shown, and nothing about research", async () => {
    const posted = serve();
    await recordAgreements(answers);
    expect(posted).toEqual([
      { kind: "terms", version: TERMS, locale: "sv" },
      { kind: "privacy", version: PRIVACY, locale: "sv" },
    ]);
    expect(await agreedOnThisPhone()).toBe(true);
  });

  it("skips the privacy summary and the memory when the terms are refused", async () => {
    const posted = serve({ terms: () => refusal("consent_version_outdated", 409) });
    await expect(recordAgreements(answers)).resolves.toBeUndefined();
    expect(posted.map((p) => p.kind)).toEqual(["terms"]);
    expect(store.has(AGREED)).toBe(false);
    expect(await agreedOnThisPhone()).toBe(false);
  });

  it("does not remember the phone when the privacy summary is refused after the terms", async () => {
    const posted = serve({ privacy: () => refusal("rate_limited", 429) });
    await recordAgreements(later);
    expect(posted.map((p) => p.kind)).toEqual(["terms", "privacy"]);
    expect(store.has(AGREED)).toBe(false);
  });

  it("swallows a phone without network, and remembers nothing", async () => {
    const posted = serve({ terms: networkDown });
    await expect(recordAgreements(answers)).resolves.toBeUndefined();
    expect(posted.map((p) => p.kind)).toEqual(["terms"]);
    expect(store.has(AGREED)).toBe(false);
  });
});

describe("giveAgreements", () => {
  it("gives the terms, then the privacy summary, then remembers this phone", async () => {
    const posted = serve();
    await giveAgreements(answers);
    expect(posted).toEqual([
      { kind: "terms", version: TERMS, locale: "sv" },
      { kind: "privacy", version: PRIVACY, locale: "sv" },
    ]);
    expect(await agreedOnThisPhone()).toBe(true);
  });

  it("hands a refusal on to the step that asked, and remembers nothing", async () => {
    const posted = serve({ privacy: () => refusal("consent_version_outdated", 409) });
    await expect(giveAgreements(answers)).rejects.toMatchObject({
      code: "consent_version_outdated",
    });
    expect(posted.map((p) => p.kind)).toEqual(["terms", "privacy"]);
    expect(store.has(AGREED)).toBe(false);
  });
});
