import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AccountDeletionRequest,
  AccountEmail,
  AccountEmailResponse,
  AccountExport,
  EMAIL_MAX,
  ExportedPhoto,
} from "./account.ts";

// The account's own lifecycle (#51, #148): the optional e-mail, the deletion
// request and the export, at their boundaries.

const codes = (schema: z.ZodType, input: unknown) =>
  schema.safeParse(input).error?.issues.map((issue) => issue.code) ?? [];

/** An address of exactly `length` characters on the documentation domain. */
const addressOfLength = (length: number) => {
  const domain = "@example.com";
  return `${"a".repeat(length - domain.length)}${domain}`;
};

describe("the optional e-mail", () => {
  it("takes an address up to the RFC's 254 characters and refuses one longer", () => {
    expect(EMAIL_MAX).toBe(254);
    expect(AccountEmail.parse({ email: addressOfLength(254) }).email).toHaveLength(254);
    expect(codes(AccountEmail, { email: addressOfLength(255) })).toEqual(["too_big"]);
  });

  it.each([
    ["no at sign", "person.example.com"],
    ["no domain", "person@"],
    ["no top-level domain", "person@example"],
    ["a space", "per son@example.com"],
    ["empty", ""],
  ])("refuses an address with %s", (_, email) => {
    expect(codes(AccountEmail, { email })).toContain("invalid_format");
  });

  it("refuses a missing, a non-string and an extra field", () => {
    expect(codes(AccountEmail, {})).toEqual(["invalid_type"]);
    expect(codes(AccountEmail, { email: 42 })).toEqual(["invalid_type"]);
    expect(codes(AccountEmail, { email: "person@example.com", verified: true })).toEqual([
      "unrecognized_keys",
    ]);
  });

  it("reads back an address or null, never more than the cap", () => {
    expect(AccountEmailResponse.parse({ email: null })).toEqual({ email: null });
    expect(AccountEmailResponse.parse({ email: "person@example.com" }).email).toBe(
      "person@example.com",
    );
    expect(codes(AccountEmailResponse, { email: "a".repeat(255) })).toEqual(["too_big"]);
    expect(codes(AccountEmailResponse, {})).toEqual(["invalid_type"]);
  });
});

describe("the deletion request", () => {
  it("is accepted only with confirm set to true", () => {
    expect(AccountDeletionRequest.parse({ confirm: true })).toEqual({ confirm: true });
  });

  it.each([
    ["false", { confirm: false }],
    ["the string true", { confirm: "true" }],
    ["one", { confirm: 1 }],
    ["nothing", {}],
    ["no body at all", undefined],
  ])("refuses confirm as %s, so a stray call erases nothing", (_, body) => {
    expect(AccountDeletionRequest.safeParse(body).success).toBe(false);
  });

  it("refuses an extra field", () => {
    expect(codes(AccountDeletionRequest, { confirm: true, accountId: "x" })).toEqual([
      "unrecognized_keys",
    ]);
  });
});

const at = "2026-10-01T12:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const photo = (n: number) => ({
  id: uuid(100 + n),
  blurhash: "LEHV6nWB2yk8",
  width: 1200,
  height: 1600,
  state: "approved",
  rejectionReason: null,
  appealable: false,
  position: n,
  createdAt: at,
  file: `photos/${uuid(100 + n)}.webp`,
  review: { decision: "approved", reason: null, decidedByStaff: false, decidedAt: at },
  descriptionText: null,
});

const consent = (kind: string) => ({
  kind,
  version: "2026-09-01",
  locale: "fi",
  givenAt: at,
  withdrawnAt: null,
});

function anExport(): Record<string, unknown> {
  return {
    exportedAt: at,
    exportedBy: "0.16.0-37a837c",
    account: {
      id: uuid(1),
      state: "active",
      registeredAt: at,
      birthYear: 1990,
      birthMonth: 5,
      gender: "woman",
      pond: {
        id: uuid(2),
        slug: "helsinki",
        name: "Helsinki",
        nameInessive: "Helsingissä",
        parentId: null,
      },
      stateChangedAt: null,
      genderChangedAt: null,
      seeksChangedAt: null,
      email: null,
    },
    preferences: { seeks: ["man"], ageWindow: { min: 25, max: 40 } },
    dealBreakers: [{ field: "smoking", accept: ["never"], includeUnknown: true, paused: false }],
    consents: [consent("terms"), consent("privacy")],
    identity: {
      firstSeenAt: at,
      lastBankLoginAt: at,
      loginLevel: "http://ftn.ficora.fi/2017/loa2",
      standing: "ok",
      standingChangedAt: null,
      deletionCount: 0,
      refusedAttempts: 0,
      reregisterAfter: null,
    },
    sessions: [
      {
        sessionId: uuid(3),
        platform: "ios",
        userAgent: "Kuutti/0.13 (iPhone; iOS 19)",
        createdAt: at,
        lastUsedAt: at,
        expiresAt: at,
      },
    ],
    profile: null,
    photos: [photo(0)],
    photoAccessLog: [{ photoId: uuid(100), variant: "thumb", at }],
    cardsShown: [{ photoId: uuid(101), at }],
    photoCheck: {
      about: "Kuutti checks every photo before anyone else sees it.",
      photosNotShown: [{ at, kind: "nudity", reason: "May show more than Kuutti allows" }],
      carefulCheckUntil: at,
    },
    research: { enrolled: false, since: null, consentVersion: null, events: [] },
    gate: null,
    exports: [{ at }],
    feedback: [
      {
        at,
        kind: "idea",
        text: "The map is slow on my phone.",
        appVersion: "0.22.0",
        platform: "ios",
        locale: "fi",
        handledAt: null,
      },
    ],
  };
}

describe("the account export", () => {
  it("parses a complete export and keeps what it says", () => {
    const parsed = AccountExport.parse(anExport());
    expect(parsed.account.birthYear).toBe(1990);
    expect(parsed.photos[0]?.file).toBe(`photos/${uuid(100)}.webp`);
    expect(parsed.exportedBy).toBe("0.16.0-37a837c");
    expect(parsed.exports).toEqual([{ at }]);
    expect(parsed.dealBreakers[0]?.paused).toBe(false);
  });

  it("drops a key it does not define, so a stray hetu_hmac or research_id never reaches the file", () => {
    const leaky = anExport();
    leaky.hetuHmac = "deadbeef";
    leaky.researchId = uuid(9);
    (leaky.account as Record<string, unknown>).hetu = "010190-123A";
    const parsed = AccountExport.parse(leaky) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("hetuHmac");
    expect(parsed).not.toHaveProperty("researchId");
    expect(parsed.account).not.toHaveProperty("hetu");
  });

  it("holds the account's nullable answers as null before onboarding and after erasure", () => {
    const erased = anExport();
    erased.account = {
      ...(erased.account as object),
      state: "deleted",
      birthYear: null,
      birthMonth: null,
      gender: null,
      pond: null,
    };
    erased.preferences = { seeks: null, ageWindow: null };
    expect(AccountExport.safeParse(erased).success).toBe(true);
  });

  it("names the photo check's kinds from a closed list, and the end of the closer look or null (#253)", () => {
    const parsed = AccountExport.parse(anExport());
    expect(parsed.photoCheck.photosNotShown[0]?.kind).toBe("nudity");
    const unknown = anExport();
    unknown.photoCheck = {
      about: "x",
      photosNotShown: [{ at: new Date().toISOString(), kind: "explicit", reason: "x" }],
      carefulCheckUntil: null,
    };
    expect(codes(AccountExport, unknown)).toEqual(["invalid_value"]);
    const none = anExport();
    none.photoCheck = { about: "x", photosNotShown: [], carefulCheckUntil: null };
    expect(AccountExport.safeParse(none).success).toBe(true);
  });

  it("refuses a negative deletion count and a fractional birth year", () => {
    const negative = anExport();
    negative.identity = { ...(negative.identity as object), deletionCount: -1 };
    expect(codes(AccountExport, negative)).toEqual(["too_small"]);
    const fractional = anExport();
    fractional.account = { ...(fractional.account as object), birthYear: 1990.5 };
    expect(codes(AccountExport, fractional)).toEqual(["invalid_type"]);
  });

  it.each<[string, number, () => unknown]>([
    [
      "dealBreakers",
      5,
      () => ({ field: "smoking", accept: ["never"], includeUnknown: true, paused: false }),
    ],
    ["photos", 50, () => photo(0)],
    ["photoAccessLog", 1000, () => ({ photoId: uuid(100), variant: "card", at })],
    ["cardsShown", 1000, () => ({ photoId: uuid(101), at })],
    [
      "feedback",
      1000,
      () => ({
        at,
        kind: "praise",
        text: "x",
        appVersion: "0.22.0",
        platform: "web",
        locale: "sv",
        handledAt: at,
      }),
    ],
  ])("holds at most so many %s: %i", (key, max, entry) => {
    const full = anExport();
    full[key] = Array.from({ length: max }, entry);
    expect(AccountExport.safeParse(full).success).toBe(true);
    const over = anExport();
    over[key] = Array.from({ length: max + 1 }, entry);
    expect(codes(AccountExport, over)).toEqual(["too_big"]);
  });

  it("takes ten thousand consents and refuses one more", () => {
    const full = anExport();
    full.consents = Array.from({ length: 10_000 }, () => consent("research"));
    expect(AccountExport.safeParse(full).success).toBe(true);
    const over = anExport();
    over.consents = Array.from({ length: 10_001 }, () => consent("research"));
    expect(codes(AccountExport, over)).toEqual(["too_big"]);
  });

  it("holds a device's user agent only as long as login keeps it, a standing from the closed list, and no negative refusal count", () => {
    const longer = anExport();
    longer.sessions = [{ ...(longer.sessions as object[])[0], userAgent: "x".repeat(201) }];
    expect(codes(AccountExport, longer)).toEqual(["too_big"]);
    const silent = anExport();
    silent.sessions = [{ ...(silent.sessions as object[])[0], userAgent: null }];
    expect(AccountExport.safeParse(silent).success).toBe(true);
    const frozen = anExport();
    frozen.identity = { ...(frozen.identity as object), standing: "frozen" };
    expect(codes(AccountExport, frozen)).toEqual(["invalid_value"]);
    const negative = anExport();
    negative.identity = { ...(negative.identity as object), refusedAttempts: -1 };
    expect(codes(AccountExport, negative)).toEqual(["too_small"]);
  });

  it("refuses an unknown session platform and a timestamp that is not ISO 8601", () => {
    const web = anExport();
    web.sessions = [{ ...(web.sessions as object[])[0], platform: "web" }];
    expect(codes(AccountExport, web)).toEqual(["invalid_value"]);
    const local = anExport();
    local.exportedAt = "1.10.2026 12:00";
    expect(codes(AccountExport, local)).toEqual(["invalid_format"]);
  });
});

describe("an exported photo", () => {
  it("has no file when the API has no object storage, and no review before the check", () => {
    const bare = { ...photo(0), file: null, review: null };
    expect(ExportedPhoto.parse(bare)).toMatchObject({ file: null, review: null });
  });

  it("names a rejection's reason and whether a person decided it", () => {
    const rejected = {
      ...photo(1),
      state: "rejected",
      rejectionReason: "minor",
      review: { decision: "rejected", reason: "minor", decidedByStaff: true, decidedAt: at },
    };
    expect(ExportedPhoto.parse(rejected).review).toEqual({
      decision: "rejected",
      reason: "minor",
      decidedByStaff: true,
      decidedAt: at,
    });
  });

  it("carries the check's description in words as well as its keys (#296), or neither", () => {
    const description = {
      people: 1,
      setting: "outdoors",
      scene: ["lake"],
      objects: ["dog"],
      smile: true,
      glasses: false,
      sunglasses: false,
      facialHair: false,
    };
    const described = {
      ...photo(2),
      description,
      descriptionText:
        "Automatic description: One person, outdoors, by a lake. Smiling. With a dog.",
    };
    expect(ExportedPhoto.parse(described)).toMatchObject({
      description,
      descriptionText: described.descriptionText,
    });
    expect(ExportedPhoto.parse(photo(0))).toMatchObject({
      description: null,
      descriptionText: null,
    });
    expect(codes(ExportedPhoto, { ...photo(0), descriptionText: "x".repeat(601) })).toEqual([
      "too_big",
    ]);
    expect(codes(ExportedPhoto, { ...photo(0), descriptionText: undefined })).toEqual([
      "invalid_type",
    ]);
  });

  it.each([
    ["a review decision outside the list", { decision: "pending" }, "invalid_value"],
    ["a reason outside the list", { reason: "ugly" }, "invalid_value"],
    ["a file path longer than a photo's", { file: `photos/${"a".repeat(60)}.webp` }, "too_big"],
  ])("refuses %s", (_, change, code) => {
    const base = photo(0);
    const changed =
      "file" in change
        ? { ...base, ...change }
        : { ...base, review: { ...base.review, ...change } };
    expect(codes(ExportedPhoto, changed)).toContain(code);
  });
});
