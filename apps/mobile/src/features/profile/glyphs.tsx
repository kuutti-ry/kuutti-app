import type { ProfileFieldKey } from "@kuutti/schema";
import { Image } from "expo-image";
import { cssInterop } from "nativewind";
import { Platform } from "react-native";
import { cn } from "@/lib/utils";
import { DECORATIVE } from "@/theme/a11y";

/**
 * A glyph before an option's name (#213, ADR-019 §3): a party's mark, a
 * religion's symbol, a star sign. Every glyph is black and white (the
 * maintainer, 10/10/2026: no colours, the parties' included): ink on
 * transparency, tinted with the text colour the way the home screen's mark
 * is. The name stays the text and the glyph is decorative, hidden from screen
 * readers, so no meaning rests on it (CLAUDE.md Accessibility). Sources,
 * terms and the edits made: assets/glyphs/NOTICE.md.
 */
const ink = (source: number): number => source;

const OPTION_GLYPHS = {
  politics: {
    kesk: ink(require("../../../assets/glyphs/politics/kesk.svg")),
    kok: ink(require("../../../assets/glyphs/politics/kok.svg")),
    kd: ink(require("../../../assets/glyphs/politics/kd.svg")),
    liik: ink(require("../../../assets/glyphs/politics/liik.png")),
    ps: ink(require("../../../assets/glyphs/politics/ps.png")),
    pp: ink(require("../../../assets/glyphs/politics/pp.svg")),
    rkp: ink(require("../../../assets/glyphs/politics/rkp.svg")),
    sdp: ink(require("../../../assets/glyphs/politics/sdp.svg")),
    vas: ink(require("../../../assets/glyphs/politics/vas.svg")),
    vihr: ink(require("../../../assets/glyphs/politics/vihr.png")),
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
} satisfies Partial<Record<ProfileFieldKey, Readonly<Record<string, number>>>>;

export type GlyphField = keyof typeof OPTION_GLYPHS;
export const GLYPH_FIELDS = Object.keys(OPTION_GLYPHS) as GlyphField[];

/** Whether any option of the field has a glyph: the card lays those out as a row of glyph and name. */
export const hasGlyphs = (field: ProfileFieldKey): field is GlyphField => field in OPTION_GLYPHS;

export function optionGlyph(field: ProfileFieldKey, option: string): number | null {
  if (!hasGlyphs(field)) return null;
  const glyphs: Readonly<Record<string, number>> = OPTION_GLYPHS[field];
  return glyphs[option] ?? null;
}

// The text colour class is handed over as tintColor, native only (the home
// screen's mark explains); on the web target the ink is inverted under dark.
const Tinted = cssInterop(Image, {
  className: { target: "style", nativeStyleToProp: { color: "tintColor" } },
});

/**
 * The glyph of one option, or nothing. `className` names the text colour the
 * ink takes: the chip's own when the chip is selected.
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
  const source = optionGlyph(field, option);
  if (source === null) return null;
  return (
    <Tinted
      source={source}
      contentFit="contain"
      className={cn("h-5 w-5", className, Platform.select({ web: "dark:invert" }))}
      {...DECORATIVE}
    />
  );
}
