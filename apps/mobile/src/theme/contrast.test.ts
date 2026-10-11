import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  checkContrast,
  contrastRatio,
  hslChannelsToRgb,
  parseTokenSets,
  relativeLuminance,
} from "./contrast";

const TOKENS = readFileSync(resolve(__dirname, "tokens.css"), "utf8");

describe("contrast", () => {
  it("gives black on white 21:1 and a colour on itself 1:1", () => {
    const black = hslChannelsToRgb("0 0% 0%");
    const white = hslChannelsToRgb("0 0% 100%");
    if (!black || !white) throw new Error("unparsed");
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
    expect(relativeLuminance(white)).toBeCloseTo(1, 5);
  });

  it("converts HSL channels to the sRGB the hex notation gives", () => {
    // hsl(224 76% 48%) is #1D4ED8 to within rounding.
    const rgb = hslChannelsToRgb("224 76% 48%")?.map((c) => Math.round(c * 255));
    expect(rgb).toEqual([29, 79, 215]);
    expect(hslChannelsToRgb("8px")).toBeNull();
  });

  it("finds the four token sets of tokens.css", () => {
    expect(Object.keys(parseTokenSets(TOKENS))).toEqual([
      ":root",
      ".dark:root",
      ".high-contrast",
      ".high-contrast-dark",
    ]);
  });

  it("passes every pair of every committed token set", () => {
    expect(checkContrast(parseTokenSets(TOKENS))).toEqual([]);
  });

  it("fails when one token drops below 4.5:1", () => {
    const sets = parseTokenSets(TOKENS);
    const light = sets[":root"];
    if (!light) throw new Error("no :root set");
    // Grey at 60% lightness on white is about 2.8:1.
    const failures = checkContrast({ ":root": { ...light, "muted-foreground": "215 19% 60%" } });
    expect(failures.map((f) => `${f.foreground}/${f.background}`)).toEqual([
      "muted-foreground/muted",
      "muted-foreground/background",
      "muted-foreground/card",
    ]);
    expect(failures.every((f) => f.required === 4.5 && f.ratio < 4.5)).toBe(true);
  });

  it("holds the high-contrast sets to 7:1 and fails a set that cannot be checked", () => {
    const sets = parseTokenSets(TOKENS);
    const light = sets[":root"];
    if (!light) throw new Error("no :root set");
    // The ordinary light set is AA, not AAA: under the high-contrast name it must fail.
    expect(checkContrast({ ".high-contrast": light }).some((f) => f.required === 7)).toBe(true);
    const { background: _dropped, ...withoutBackground } = light;
    expect(checkContrast({ ":root": withoutBackground }).some((f) => f.ratio === 0)).toBe(true);
  });

  it("converts a grey without a hue and a hue past 240 degrees", () => {
    expect(hslChannelsToRgb("0 0% 50%")).toEqual([0.5, 0.5, 0.5]);
    expect(hslChannelsToRgb("300 100% 50%")?.map((c) => Math.round(c * 255))).toEqual([
      255, 0, 255,
    ]);
  });

  it("leaves out a block that declares no custom property", () => {
    expect(parseTokenSets("body { margin: 0; } :root { --ring: 1 2% 3%; }")).toEqual({
      ":root": { ring: "1 2% 3%" },
    });
  });

  it("fails a pair whose text colour is missing", () => {
    const light = parseTokenSets(TOKENS)[":root"];
    if (!light) throw new Error("no :root set");
    const { foreground: _dropped, ...withoutForeground } = light;
    const failures = checkContrast({ ":root": withoutForeground });
    expect(failures.filter((f) => f.foreground === "foreground").map((f) => f.ratio)).toEqual([
      0, 0,
    ]);
  });
});
