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

  it("finds the token sets of tokens.css: the base four and the try's palettes", () => {
    expect(Object.keys(parseTokenSets(TOKENS))).toEqual([
      ":root",
      ".dark:root",
      ".high-contrast",
      ".high-contrast-dark",
      ".palette-dusk",
      ".palette-dusk-dark",
      ".palette-birch",
      ".palette-birch-dark",
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

  it.each(Object.keys(parseTokenSets(TOKENS)))(
    "holds each pair of neighbours in the seeks bar to 3:1 in %s, and only neighbours",
    (name) => {
      const set = parseTokenSets(TOKENS)[name];
      if (!set) throw new Error(`no ${name} set`);
      const everyone = set["seeks-everyone"] ?? "";
      const failing = (changed: Record<string, string>) =>
        checkContrast({ [name]: { ...set, ...changed } }).map(
          (f) => `${f.foreground}/${f.background} ${f.required}`,
        );
      expect(failing({ "seeks-men": everyone })).toEqual(["seeks-men/seeks-everyone 3"]);
      expect(failing({ "seeks-women": everyone })).toEqual(["seeks-everyone/seeks-women 3"]);
      // The two ends never touch: the words, and the middle between them, tell them apart.
      expect(failing({ "seeks-women": set["seeks-men"] ?? "" })).toEqual([]);
    },
  );

  // The neubrutalism try's stroke bounds a control or a container (WCAG 1.4.11).
  it("fails a stroke fainter than 3:1 on the background or a card", () => {
    const light = parseTokenSets(TOKENS)[":root"];
    if (!light) throw new Error("no :root set");
    // A pale ink on the near-white background and the white card: about 1.5:1.
    const failures = checkContrast({ ":root": { ...light, stroke: "214 25% 78%" } });
    expect(failures.map((f) => `${f.foreground}/${f.background}`)).toEqual([
      "stroke/background",
      "stroke/card",
    ]);
    expect(failures.every((f) => f.required === 3 && f.ratio < 3)).toBe(true);
  });

  it("fails a seeks bar that misses a band", () => {
    const light = parseTokenSets(TOKENS)[":root"];
    if (!light) throw new Error("no :root set");
    const { "seeks-women": _dropped, ...withoutWomen } = light;
    expect(checkContrast({ ":root": withoutWomen })).toEqual([
      {
        set: ":root",
        foreground: "seeks-everyone",
        background: "seeks-women",
        ratio: 0,
        required: 3,
      },
    ]);
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
