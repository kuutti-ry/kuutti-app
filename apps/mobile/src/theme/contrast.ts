/**
 * WCAG contrast over the token sets in tokens.css (#12, CLAUDE.md
 * Accessibility). Pure functions: scripts/check-contrast.ts runs them in CI,
 * contrast.test.ts proves that a token below the line fails.
 */

type TokenSet = Record<string, string>;
export type TokenSets = Record<string, TokenSet>;

export type ContrastFailure = {
  set: string;
  foreground: string;
  background: string;
  ratio: number;
  required: number;
};

/** Text on its surface: AA body text, 4.5:1; 7:1 (AAA) in the high-contrast sets. */
const TEXT_PAIRS: ReadonlyArray<readonly [foreground: string, background: string]> = [
  ["foreground", "background"],
  ["foreground", "card"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["primary-foreground", "primary"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "muted"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["accent-foreground", "accent"],
  ["destructive-foreground", "destructive"],
  // primary and destructive are also used as text colours (links, errors).
  ["primary", "background"],
  ["primary", "card"],
  ["destructive", "background"],
  ["destructive", "card"],
];

/** Outlines that identify a control (WCAG 1.4.11): 3:1. --border is decorative and exempt. */
const NON_TEXT_PAIRS: ReadonlyArray<readonly [foreground: string, background: string]> = [
  ["input", "background"],
  ["input", "card"],
  ["ring", "background"],
  ["ring", "card"],
];

const AA_TEXT = 4.5;
const AAA_TEXT = 7;
const NON_TEXT = 3;

/** Every `selector { --name: value; }` block of the file, keyed by selector. */
export function parseTokenSets(css: string): TokenSets {
  const sets: TokenSets = {};
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (block[1] ?? "").trim();
    const tokens: TokenSet = {};
    for (const declaration of (block[2] ?? "").matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      const [, name, value] = declaration;
      if (name !== undefined && value !== undefined) tokens[name] = value.trim();
    }
    if (Object.keys(tokens).length > 0) sets[selector] = tokens;
  }
  return sets;
}

/** "224 76% 48%" to sRGB channels in 0..1; null when the value is not an HSL triple. */
export function hslChannelsToRgb(value: string): [number, number, number] | null {
  const match = /^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(value.trim());
  if (!match) return null;
  const hue = (((Number(match[1]) % 360) + 360) % 360) / 360;
  const saturation = Number(match[2]) / 100;
  const lightness = Number(match[3]) / 100;
  if (saturation === 0) return [lightness, lightness, lightness];
  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const channel = (t: number): number => {
    const wrapped = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (wrapped < 1 / 6) return p + (q - p) * 6 * wrapped;
    if (wrapped < 1 / 2) return q;
    if (wrapped < 2 / 3) return p + (q - p) * (2 / 3 - wrapped) * 6;
    return p;
  };
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)];
}

export function relativeLuminance([r, g, b]: [number, number, number]): number {
  const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Every pair in every set. A colour token that is missing or not an HSL triple
 * is a failure too (ratio 0): a set that cannot be checked must not pass.
 */
export function checkContrast(sets: TokenSets): ContrastFailure[] {
  const failures: ContrastFailure[] = [];
  for (const [set, tokens] of Object.entries(sets)) {
    const textRequired = set.includes("high-contrast") ? AAA_TEXT : AA_TEXT;
    const pairs = [
      ...TEXT_PAIRS.map((pair) => [...pair, textRequired] as const),
      ...NON_TEXT_PAIRS.map((pair) => [...pair, NON_TEXT] as const),
    ];
    for (const [foreground, background, required] of pairs) {
      const fg = hslChannelsToRgb(tokens[foreground] ?? "");
      const bg = hslChannelsToRgb(tokens[background] ?? "");
      const ratio = fg && bg ? contrastRatio(fg, bg) : 0;
      if (ratio < required) failures.push({ set, foreground, background, ratio, required });
    }
  }
  return failures;
}
