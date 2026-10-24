// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The panel's four token sets (tokens.css, ADR-047) held to WCAG (CLAUDE.md
// Accessibility): text on its surface 4.5:1, 7:1 in the high-contrast sets;
// the outline of a control and the focus ring 3:1 (WCAG 1.4.11). The file is
// read as the stylesheet ships it.

const CSS = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

type Rgb = readonly [number, number, number];

/** Each `:root` block of the file, keyed by the media query around it ("" for the light set). */
function tokenSets(css: string): Map<string, Map<string, string>> {
  const sets = new Map<string, Map<string, string>>();
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, media = "", body = ""] of plain.matchAll(
    /(?:@media\s*([^{]+?)\s*\{\s*)?:root\s*\{([^}]*)\}/g,
  )) {
    const tokens = new Map<string, string>();
    for (const [, name = "", value = ""] of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      tokens.set(name, value.trim());
    }
    sets.set(media, tokens);
  }
  return sets;
}

/** `hsl(h s% l%)` as sRGB channels in 0..1. */
function rgbOf(value: string): Rgb {
  const match = /^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/.exec(value);
  if (!match) throw new Error(`not an hsl() colour: ${value}`);
  const [h, s, l] = [Number(match[1]) / 360, Number(match[2]) / 100, Number(match[3]) / 100];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

function luminance([r, g, b]: Rgb): number {
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(rgbOf(a)), luminance(rgbOf(b))].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** Text on the surfaces the panel puts it on: buttons, badges, links and errors included. */
const TEXT: ReadonlyArray<readonly [string, string]> = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["primary-foreground", "primary"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "muted"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["accent-foreground", "accent"],
  ["destructive-foreground", "destructive"],
  ["primary", "background"],
  ["primary", "card"],
  ["destructive", "card"],
  ["destructive", "popover"],
];

/** What marks a control or the focus. */
const OUTLINE: ReadonlyArray<readonly [string, string]> = [
  ["input", "background"],
  ["input", "card"],
  ["input", "popover"],
  ["ring", "background"],
  ["ring", "card"],
  ["ring", "popover"],
];

/** Every pair below its line in one set, as "fg/bg ratio < required". */
function failures(set: Map<string, string>, high: boolean): string[] {
  const check = (pairs: typeof TEXT, required: number) =>
    pairs.flatMap(([fg, bg]) => {
      const ratio = contrast(set.get(fg) ?? "", set.get(bg) ?? "");
      return ratio < required ? [`${fg}/${bg} ${ratio.toFixed(2)} < ${required}`] : [];
    });
  return [...check(TEXT, high ? 7 : 4.5), ...check(OUTLINE, 3)];
}

const sets = tokenSets(CSS);

describe("the panel's tokens", () => {
  it("are four sets, light, dark and the high-contrast pair, each naming every token", () => {
    expect([...sets.keys()]).toEqual([
      "",
      "(prefers-color-scheme: dark)",
      "(prefers-contrast: more)",
      "(prefers-contrast: more) and (prefers-color-scheme: dark)",
    ]);
    const names = [...(sets.get("")?.keys() ?? [])];
    expect(names).toContain("ring");
    for (const set of sets.values()) expect([...set.keys()]).toEqual(names);
  });

  it.each([...sets.keys()])("hold every pair to its line in the set %j", (media) => {
    const set = sets.get(media) ?? new Map();
    expect(failures(set, media.includes("prefers-contrast"))).toEqual([]);
  });

  it("would fail a muted text that drops below 4.5:1, and black on white is 21:1", () => {
    const light = new Map(sets.get(""));
    light.set("muted-foreground", "hsl(215 19% 60%)");
    expect(failures(light, false)).toEqual([
      expect.stringMatching(/^muted-foreground\/muted \d\.\d+ < 4\.5$/),
      expect.stringMatching(/^muted-foreground\/background \d\.\d+ < 4\.5$/),
      expect.stringMatching(/^muted-foreground\/card \d\.\d+ < 4\.5$/),
    ]);
    expect(contrast("hsl(0 0% 0%)", "hsl(0 0% 100%)")).toBeCloseTo(21, 5);
  });

  it("would hold a high-contrast set to 7:1, where the light set's primary is not enough", () => {
    const high = new Map(sets.get("(prefers-contrast: more)"));
    high.set("primary", "hsl(224 76% 48%)");
    expect(failures(high, true)).toEqual([
      expect.stringMatching(/^primary-foreground\/primary \d\.\d+ < 7$/),
      expect.stringMatching(/^primary\/background \d\.\d+ < 7$/),
      expect.stringMatching(/^primary\/card \d\.\d+ < 7$/),
    ]);
  });
});
