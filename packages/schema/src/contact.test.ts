import { describe, expect, it } from "vitest";
import {
  CONTACT_INPUT_MAX,
  ConversationContacts,
  ExportedContactShare,
  normaliseContact,
  PutContactRequest,
  StoredContacts,
} from "./contact.ts";

describe("a stored piece in its one form (#103)", () => {
  it.each([
    // A Finnish number from 0, with the spaces, hyphens, dots and brackets people type.
    ["040 123 4567", "+358401234567"],
    ["040-123 45 67", "+358401234567"],
    ["(09) 123.456", "+3589123456"],
    ["+358 40 123 4567", "+358401234567"],
    // The trunk 0 some write after the country code, which no dialled number keeps.
    ["+358 (0)40 123 4567", "+358401234567"],
    ["+358 040 123 4567", "+358401234567"],
    // As long as may be typed, the spaces counted.
    [`040${" ".repeat(CONTACT_INPUT_MAX - 10)}1234567`, "+358401234567"],
    // International from 00.
    ["0046 70 123 45 67", "+46701234567"],
    // Full-width digits, as some keyboards give them.
    ["０４０１２３４５６７", "+358401234567"],
    // E.164's bounds: seven digits after the country's first, fifteen in all.
    ["+1234567", "+1234567"],
    ["+123456789012345", "+123456789012345"],
  ])("takes the phone number %j as %j, and the same for WhatsApp", (typed, stored) => {
    expect(normaliseContact("phone", typed)).toBe(stored);
    expect(normaliseContact("whatsapp", typed)).toBe(stored);
  });

  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["123", "too short"],
    ["+123456", "one digit short of E.164's least"],
    ["+1234567890123456", "one digit past E.164's sixteen"],
    ["+0401234567", "a country code from 0"],
    ["040 abc 4567", "letters"],
    ["aino@example.fi", "an address"],
    [`040${" ".repeat(CONTACT_INPUT_MAX - 9)}1234567`, "one character longer than may be typed"],
  ])("refuses %j as a phone number (%s)", (typed) => {
    expect(normaliseContact("phone", typed)).toBeNull();
    expect(normaliseContact("whatsapp", typed)).toBeNull();
  });

  it.each([
    ["@aino_k", "aino_k"],
    ["Aino_K", "Aino_K"],
    ["abcde", "abcde"],
    [`a${"b".repeat(31)}`, `a${"b".repeat(31)}`],
    ["  @Ville2026  ", "Ville2026"],
  ])("takes the Telegram username %j as %j", (typed, stored) => {
    expect(normaliseContact("telegram", typed)).toBe(stored);
  });

  it.each([
    ["abcd", "four characters, one short"],
    [`a${"b".repeat(32)}`, "thirty-three, one over"],
    ["1abcde", "a digit first"],
    ["ab-cde", "a hyphen"],
    ["aino k", "a space"],
    ["@", "the @ alone"],
  ])("refuses %j as a Telegram username (%s)", (typed) => {
    expect(normaliseContact("telegram", typed)).toBeNull();
  });

  it.each([
    ["@Aino.K", "aino.k"],
    ["a", "a"],
    ["ville_2026", "ville_2026"],
    ["x".repeat(30), "x".repeat(30)],
  ])("takes the Instagram username %j as %j, in lower case", (typed, stored) => {
    expect(normaliseContact("instagram", typed)).toBe(stored);
  });

  it.each([
    [".aino", "a dot first"],
    ["aino.", "a dot last"],
    ["ai..no", "two dots in a row"],
    ["x".repeat(31), "thirty-one, one over"],
    ["aino k", "a space"],
    ["aino-k", "a hyphen"],
    ["", "empty"],
  ])("refuses %j as an Instagram username (%s)", (typed) => {
    expect(normaliseContact("instagram", typed)).toBeNull();
  });
});

describe("the contracts", () => {
  it("take a value to store only alone, never empty or longer than may be typed", () => {
    expect(PutContactRequest.safeParse({ value: "@aino" }).success).toBe(true);
    expect(PutContactRequest.safeParse({ value: "" }).success).toBe(false);
    expect(PutContactRequest.safeParse({ value: "a".repeat(CONTACT_INPUT_MAX + 1) }).success).toBe(
      false,
    );
    expect(PutContactRequest.safeParse({ value: "@aino", kind: "phone" }).success).toBe(false);
  });

  it("hold one piece per kind at most, and only the four kinds", () => {
    const at = "2026-10-18T10:00:00.000Z";
    const piece = { kind: "phone", value: "+358401234567", updatedAt: at };
    expect(StoredContacts.safeParse({ contacts: [piece] }).success).toBe(true);
    expect(StoredContacts.safeParse({ contacts: Array(5).fill(piece) }).success).toBe(false);
    expect(StoredContacts.safeParse({ contacts: [{ ...piece, kind: "email" }] }).success).toBe(
      false,
    );
    expect(
      ConversationContacts.safeParse({
        mine: [{ kind: "telegram", value: "aino_k", shared: true }],
        theirs: [{ kind: "instagram", value: "ville.k" }],
      }).success,
    ).toBe(true);
  });

  it("export a share as its record: the kind and the times, and how it ended or null while it stands", () => {
    const at = "2026-10-18T10:00:00.000Z";
    expect(
      ExportedContactShare.parse({ kind: "phone", sharedAt: at, endedAt: null, endedHow: null }),
    ).toEqual({ kind: "phone", sharedAt: at, endedAt: null, endedHow: null });
    expect(
      ExportedContactShare.safeParse({ kind: "phone", sharedAt: at, endedAt: at, endedHow: "lost" })
        .success,
    ).toBe(false);
  });
});
