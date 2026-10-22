import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  ExportedInvitations,
  groupInvitationCode,
  INVITATION_CODE_ALPHABET,
  INVITATION_CODE_GROUPED_PATTERN,
  INVITATION_CODE_INPUT_MAX,
  INVITATION_CODE_LENGTH,
  INVITATION_CODE_PATTERN,
  INVITATION_REWARD_FISH_MAX,
  INVITATION_REWARD_LIKES_MAX,
  INVITATIONS_OPEN_CAP,
  InvitationCreated,
  InvitationParams,
  InvitationRedeemRequest,
  InvitationReward,
  InvitationState,
  Invitations,
  normaliseInvitationCode,
  RewardKind,
  RewardUnits,
} from "./rewards.ts";

// Invitations and the reward they earn (#107, ADR-044) at their boundaries:
// the code's format and how a typed code is read, the config's shape, what
// the app is told, and what the export carries.

const codes = (schema: z.ZodType, input: unknown) =>
  schema.safeParse(input).error?.issues.map((issue) => issue.code) ?? [];
const at = "2026-10-22T09:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("the code's format", () => {
  it("is ten characters of Crockford's base32, fifty bits", () => {
    expect(new Set(INVITATION_CODE_ALPHABET).size).toBe(32);
    expect(INVITATION_CODE_ALPHABET).toHaveLength(32);
    expect(INVITATION_CODE_LENGTH * Math.log2(INVITATION_CODE_ALPHABET.length)).toBe(50);
    // No letter that reads as another: I, L and O look like 1 and 0, and U is left out by Crockford.
    expect(INVITATION_CODE_ALPHABET).not.toMatch(/[ILOU]/);
  });

  it("takes every character of the alphabet and nothing else", () => {
    for (const character of INVITATION_CODE_ALPHABET) {
      expect(INVITATION_CODE_PATTERN.test(character.repeat(10)), character).toBe(true);
    }
    const others = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)).filter(
      (character) => !INVITATION_CODE_ALPHABET.includes(character),
    );
    for (const character of others) {
      expect(INVITATION_CODE_PATTERN.test(character.repeat(10)), character).toBe(false);
    }
  });

  it.each([
    ["nine characters", "ABCDEFGHJ", false],
    ["ten", "ABCDEFGHJK", true],
    ["eleven", "ABCDEFGHJKM", false],
    ["none", "", false],
    ["ten in lower case", "abcdefghjk", false],
  ])("as stored, takes %s: %s", (_case, code, valid) => {
    expect(INVITATION_CODE_PATTERN.test(code)).toBe(valid);
  });

  it.each([
    ["two groups of five", "ABCDE-FGHJK", true],
    ["no hyphen", "ABCDEFGHJK", false],
    ["groups of four and six", "ABCD-EFGHJK", false],
    ["a space for the hyphen", "ABCDE FGHJK", false],
    ["a letter outside the alphabet", "ABCDE-FGHJU", false],
  ])("as shown, takes %s: %s", (_case, code, valid) => {
    expect(INVITATION_CODE_GROUPED_PATTERN.test(code)).toBe(valid);
  });
});

describe("a typed code", () => {
  it.each([
    ["as shown", "ABCDE-FGHJK", "ABCDEFGHJK"],
    ["in lower case", "abcde-fghjk", "ABCDEFGHJK"],
    ["with spaces anywhere", " AB CDE  FGHJK ", "ABCDEFGHJK"],
    ["with a tab and a line break", "ABCDE\tFGHJK\n", "ABCDEFGHJK"],
    ["with hyphens anywhere", "-A-B-C-D-E-F-G-H-J-K-", "ABCDEFGHJK"],
    ["with O for zero", "OoOoO-12345", "0000012345"],
    ["with I and L for one", "IiLlI-23456", "1111123456"],
    ["with a U, which no reading turns into anything", "uUUUU-00000", "UUUUU00000"],
    ["empty", "", ""],
  ])("is read %s", (_case, typed, stored) => {
    expect(normaliseInvitationCode(typed)).toBe(stored);
  });

  it("comes back to its stored form from the form it is shown in", () => {
    for (let shift = 0; shift < INVITATION_CODE_ALPHABET.length; shift += 1) {
      const code = Array.from(
        { length: INVITATION_CODE_LENGTH },
        (_, i) => INVITATION_CODE_ALPHABET[(shift + i * 7) % INVITATION_CODE_ALPHABET.length],
      ).join("");
      const shown = groupInvitationCode(code);
      expect(INVITATION_CODE_GROUPED_PATTERN.test(shown), shown).toBe(true);
      expect(normaliseInvitationCode(shown)).toBe(code);
      expect(normaliseInvitationCode(shown.toLowerCase())).toBe(code);
    }
  });

  it.each([
    ["as shown", "ABCDE-FGHJK"],
    ["in lower case with spaces", "abcde fghjk"],
    ["with the letters read as digits", "OIL00-12345"],
    ["with spaces up to the limit", `ABCDE-FGHJK${" ".repeat(INVITATION_CODE_INPUT_MAX - 11)}`],
  ])("is taken %s", (_case, code) => {
    expect(InvitationRedeemRequest.parse({ code })).toEqual({ code });
  });

  it.each([
    ["nine characters", { code: "ABCDE-FGHJ" }, ["custom"]],
    ["eleven characters", { code: "ABCDE-FGHJKM" }, ["custom"]],
    ["a letter outside the alphabet", { code: "ABCDE-FGHJU" }, ["custom"]],
    ["a character that is not a letter", { code: "ABCDE_FGHJK" }, ["custom"]],
    ["nothing", { code: "" }, ["custom"]],
    [
      "a code past the limit, however it reads",
      { code: `ABCDE-FGHJK${" ".repeat(INVITATION_CODE_INPUT_MAX - 10)}` },
      ["too_big"],
    ],
    ["a number", { code: 1234567890 }, ["invalid_type"]],
    ["no code", {}, ["invalid_type"]],
    ["anything beside the code", { code: "ABCDE-FGHJK", from: "Sanna" }, ["unrecognized_keys"]],
  ])("is refused as %s", (_case, body, expected) => {
    expect(codes(InvitationRedeemRequest, body)).toEqual(expected);
  });
});

describe("the reward of matching_config", () => {
  it("is one fish and no likes by default, and either kind may be switched off", () => {
    expect(InvitationReward.parse({ fish: 1, likes: 0 })).toEqual({ fish: 1, likes: 0 });
    expect(InvitationReward.parse({ fish: 0, likes: 0 })).toEqual({ fish: 0, likes: 0 });
    expect(
      InvitationReward.parse({
        fish: INVITATION_REWARD_FISH_MAX,
        likes: INVITATION_REWARD_LIKES_MAX,
      }),
    ).toEqual({ fish: 10, likes: 50 });
  });

  it.each([
    ["more fish than the ceiling", { fish: 11, likes: 0 }, "too_big"],
    ["more likes than the ceiling", { fish: 0, likes: 51 }, "too_big"],
    ["a negative amount", { fish: -1, likes: 0 }, "too_small"],
    ["a fraction", { fish: 1, likes: 0.5 }, "invalid_type"],
    ["an amount as a string", { fish: "1", likes: 0 }, "invalid_type"],
    ["a kind left out", { fish: 1 }, "invalid_type"],
    ["a kind it does not know", { fish: 1, likes: 0, boosts: 1 }, "unrecognized_keys"],
  ])("refuses %s", (_case, value, code) => {
    expect(codes(InvitationReward, value)).toEqual([code]);
  });

  it("names its units like or fish", () => {
    expect(RewardKind.options).toEqual(["like", "fish"]);
  });
});

describe("what the app is told", () => {
  const invitations = {
    canInvite: true,
    redeemable: false,
    reward: { fish: 1, likes: 0 },
    open: [{ id: uuid(1), createdAt: at }],
    counted: 2,
    earned: { fish: 2, likes: 0 },
  };

  it("is whether the person may invite and redeem, the reward, the open ones, how many counted and what is left", () => {
    expect(Invitations.parse(invitations)).toEqual(invitations);
    // Earned units have no ceiling: they bank.
    expect(RewardUnits.parse({ fish: 40, likes: 500 })).toEqual({ fish: 40, likes: 500 });
  });

  it.each([
    [
      "more open invitations than the contract's ceiling",
      { open: Array.from({ length: INVITATIONS_OPEN_CAP + 1 }, () => invitations.open[0]) },
      "too_big",
    ],
    ["a negative count", { counted: -1 }, "too_small"],
    ["a negative unit left", { earned: { fish: -1, likes: 0 } }, "too_small"],
    ["a fractional unit left", { earned: { fish: 1.5, likes: 0 } }, "invalid_type"],
    ["a reward past its ceiling", { reward: { fish: 11, likes: 0 } }, "too_big"],
    ["an open invitation without its id", { open: [{ createdAt: at }] }, "invalid_type"],
    [
      "a date that is not ISO 8601",
      { open: [{ id: uuid(1), createdAt: "22.10.2026" }] },
      "invalid_format",
    ],
  ])("refuses %s", (_case, change, code) => {
    expect(codes(Invitations, { ...invitations, ...change })).toEqual([code]);
  });

  it("gives a new invitation's code once, in two groups", () => {
    const created = { id: uuid(2), code: "ABCDE-FGHJK", createdAt: at };
    expect(InvitationCreated.parse(created)).toEqual(created);
    expect(codes(InvitationCreated, { ...created, code: "ABCDEFGHJK" })).toEqual([
      "invalid_format",
    ]);
    expect(codes(InvitationCreated, { ...created, code: "abcde-fghjk" })).toEqual([
      "invalid_format",
    ]);
  });

  it("names an invitation by its id alone", () => {
    expect(InvitationParams.parse({ id: uuid(3) })).toEqual({ id: uuid(3) });
    expect(codes(InvitationParams, { id: "ABCDE-FGHJK" })).toEqual(["invalid_format"]);
    expect(codes(InvitationParams, { id: uuid(3), code: "ABCDE-FGHJK" })).toEqual([
      "unrecognized_keys",
    ]);
  });
});

describe("the export", () => {
  const exported = {
    made: [
      { createdAt: at, state: "counted", countedAt: at },
      { createdAt: at, state: "redeemed", countedAt: null },
      { createdAt: at, state: "open", countedAt: null },
    ],
    used: { redeemedAt: at, countedAt: null },
    rewards: [
      { kind: "fish", earnedAt: at, spentAt: at },
      { kind: "like", earnedAt: at, spentAt: null },
    ],
  };

  it("carries the invitations made, the one used and the units earned, never a code or the other person", () => {
    expect(InvitationState.options).toEqual(["open", "redeemed", "counted"]);
    const leaky = {
      ...exported,
      made: [{ ...exported.made[0], code: "ABCDE-FGHJK", redeemedBy: uuid(4) }],
      used: { ...exported.used, inviter: uuid(5) },
    };
    const parsed = ExportedInvitations.parse(leaky);
    expect(parsed.made).toEqual([exported.made[0]]);
    expect(parsed.used).toEqual(exported.used);
    expect(ExportedInvitations.parse({ made: [], used: null, rewards: [] })).toEqual({
      made: [],
      used: null,
      rewards: [],
    });
  });

  it.each([
    [
      "a state it does not know",
      { made: [{ createdAt: at, state: "withdrawn", countedAt: null }] },
      "invalid_value",
    ],
    [
      "a unit of another kind",
      { rewards: [{ kind: "boost", earnedAt: at, spentAt: null }] },
      "invalid_value",
    ],
    ["an invitation used without when", { used: { countedAt: null } }, "invalid_type"],
  ])("refuses %s", (_case, change, code) => {
    expect(codes(ExportedInvitations, { ...exported, ...change })).toEqual([code]);
  });

  it.each<[string, () => unknown]>([
    ["made", () => exported.made[0]],
    ["rewards", () => exported.rewards[0]],
  ])("holds at most a thousand %s", (key, entry) => {
    const full = { ...exported, [key]: Array.from({ length: 1000 }, entry) };
    expect(ExportedInvitations.safeParse(full).success).toBe(true);
    const over = { ...exported, [key]: Array.from({ length: 1001 }, entry) };
    expect(codes(ExportedInvitations, over)).toEqual(["too_big"]);
  });
});
