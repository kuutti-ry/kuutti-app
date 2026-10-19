import { describe, expect, it } from "vitest";
import { openerKey } from "./first-messages.ts";

// What makes two openers the same for the automatic rule (#105, ADR-033):
// their letters and digits, case and compatibility forms folded; nothing
// else, in any script.

describe("an opener's key", () => {
  it.each([
    ["case", "Hei Sinä", "hei sinä"],
    ["spacing and line breaks", "Hei\n  sinä", "Hei sinä"],
    ["punctuation and emoji", "Hei, sinä! 😊", "Hei sinä"],
    ["full-width letters", "Ｈｅｉ ｓｉｎä", "Hei sinä"],
    ["a zero-width space", "Hei​sinä", "Hei sinä"],
    ["an emoji's variation selector and keycap", "Hei ❤️ 1️⃣", "Hei ❤ 1"],
    ["the spacing before a Greek final sigma", "ΟΔΟΣ ΚΑΛΟΣ", "ΟΔΟΣΚΑΛΟΣ"],
  ])("ignores %s", (_, one, other) => {
    expect(openerKey(one)).toBe(openerKey(other));
  });

  it.each([
    ["a changed word", "Hei sinä", "Hei te"],
    ["a changed digit", "Kello 18", "Kello 19"],
    ["ä against a", "Hei sinä", "Hei sina"],
    ["another script", "Привет", "Privet"],
    ["a Thai vowel sign", "ดี", "ดู"],
    ["a Devanagari vowel sign", "मिलो", "मालो"],
  ])("tells apart %s", (_, one, other) => {
    expect(openerKey(one)).not.toBe(openerKey(other));
  });

  it("keeps letters and digits of every script, folded", () => {
    expect(openerKey("Moi! Mitä kuuluu? 24/7")).toBe("moimitäkuuluu247");
    expect(openerKey("Привет, как дела?")).toBe("приветкакдела");
  });

  it.each([
    ["no caption", null],
    ["an empty line", ""],
    ["emoji alone", "😊😊"],
    ["punctuation alone", "?!…"],
    ["a stray mark alone", "\u0301"],
  ])("is none for %s, which is never the same as another", (_, body) => {
    expect(openerKey(body)).toBeNull();
  });
});
