import type { ProfileFieldKey } from "@kuutti/schema";
import { Image } from "expo-image";
import { cssInterop } from "nativewind";
import { Platform } from "react-native";
import { cn } from "@/lib/utils";
import { DECORATIVE } from "@/theme/a11y";

/**
 * A glyph before an option's name (#213, ADR-019 §3): a party's logo, a
 * religion's symbol, a star sign. The name stays the text and the glyph is
 * decorative, hidden from screen readers, so no meaning rests on it alone
 * (CLAUDE.md Accessibility). A monochrome symbol is ink on transparency,
 * tinted with the text colour the way the home screen's mark is; a logo
 * keeps its colours. Sources and terms: assets/glyphs/NOTICE.md.
 */
type Glyph = { source: number; ink: boolean };
const ink = (source: number): Glyph => ({ source, ink: true });
const logo = (source: number): Glyph => ({ source, ink: false });

const OPTION_GLYPHS = {
  politics: {
    kesk: logo(require("../../../assets/glyphs/politics/kesk.svg")),
    kok: logo(require("../../../assets/glyphs/politics/kok.svg")),
    kd: logo(require("../../../assets/glyphs/politics/kd.svg")),
    liik: logo(require("../../../assets/glyphs/politics/liik.png")),
    ps: logo(require("../../../assets/glyphs/politics/ps.svg")),
    pp: logo(require("../../../assets/glyphs/politics/pp.svg")),
    rkp: logo(require("../../../assets/glyphs/politics/rkp.svg")),
    sdp: logo(require("../../../assets/glyphs/politics/sdp.svg")),
    vas: logo(require("../../../assets/glyphs/politics/vas.svg")),
    vihr: logo(require("../../../assets/glyphs/politics/vihr.svg")),
  },
  religion: {
    lutheran: ink(require("../../../assets/glyphs/religion/lutheran.svg")),
    orthodox: ink(require("../../../assets/glyphs/religion/orthodox.svg")),
    other_christian: ink(require("../../../assets/glyphs/religion/other_christian.svg")),
    muslim: ink(require("../../../assets/glyphs/religion/muslim.svg")),
    buddhist: ink(require("../../../assets/glyphs/religion/buddhist.svg")),
    hindu: ink(require("../../../assets/glyphs/religion/hindu.svg")),
    jewish: ink(require("../../../assets/glyphs/religion/jewish.svg")),
  },
  zodiac: {
    aries: ink(require("../../../assets/glyphs/zodiac/aries.svg")),
    taurus: ink(require("../../../assets/glyphs/zodiac/taurus.svg")),
    gemini: ink(require("../../../assets/glyphs/zodiac/gemini.svg")),
    cancer: ink(require("../../../assets/glyphs/zodiac/cancer.svg")),
    leo: ink(require("../../../assets/glyphs/zodiac/leo.svg")),
    virgo: ink(require("../../../assets/glyphs/zodiac/virgo.svg")),
    corgi: ink(require("../../../assets/glyphs/zodiac/corgi.svg")),
    libra: ink(require("../../../assets/glyphs/zodiac/libra.svg")),
    scorpio: ink(require("../../../assets/glyphs/zodiac/scorpio.svg")),
    sagittarius: ink(require("../../../assets/glyphs/zodiac/sagittarius.svg")),
    capricorn: ink(require("../../../assets/glyphs/zodiac/capricorn.svg")),
    aquarius: ink(require("../../../assets/glyphs/zodiac/aquarius.svg")),
    pisces: ink(require("../../../assets/glyphs/zodiac/pisces.svg")),
  },
} satisfies Partial<Record<ProfileFieldKey, Readonly<Record<string, Glyph>>>>;

export type GlyphField = keyof typeof OPTION_GLYPHS;
export const GLYPH_FIELDS = Object.keys(OPTION_GLYPHS) as GlyphField[];

/** Whether any option of the field has a glyph: the card lays those out as a row of glyph and name. */
export const hasGlyphs = (field: ProfileFieldKey): field is GlyphField => field in OPTION_GLYPHS;

export function optionGlyph(field: ProfileFieldKey, option: string): Glyph | null {
  if (!hasGlyphs(field)) return null;
  const glyphs: Readonly<Record<string, Glyph>> = OPTION_GLYPHS[field];
  return glyphs[option] ?? null;
}

// The text colour class is handed over as tintColor, native only (the home
// screen's mark explains); on the web target the ink is inverted under dark.
const Tinted = cssInterop(Image, {
  className: { target: "style", nativeStyleToProp: { color: "tintColor" } },
});

/**
 * The glyph of one option, or nothing. `className` names the text colour an
 * ink glyph takes (the chip's, when the chip is selected); a logo ignores it.
 */
export function OptionGlyph({
  field,
  option,
  className = "text-foreground",
}: {
  field: ProfileFieldKey;
  option: string;
  className?: string;
}) {
  const glyph = optionGlyph(field, option);
  if (!glyph) return null;
  return (
    <Tinted
      source={glyph.source}
      contentFit="contain"
      className={cn("h-5 w-5", glyph.ink && cn(className, Platform.select({ web: "dark:invert" })))}
      {...DECORATIVE}
    />
  );
}
