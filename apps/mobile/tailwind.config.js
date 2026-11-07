// Tailwind names mapped to the design tokens in src/theme/tokens.css (#12,
// TD-9). Colours exist only as token references here: a literal colour in a
// component is a review failure (rules/mobile.md).
const token = (name) => `hsl(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  // "class": NativeWind drives .dark from the system colour scheme, and the
  // dev settings sheet can override it (src/theme/ThemeProvider.tsx).
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        background: token("background"),
        foreground: token("foreground"),
        card: { DEFAULT: token("card"), foreground: token("card-foreground") },
        popover: { DEFAULT: token("popover"), foreground: token("popover-foreground") },
        primary: { DEFAULT: token("primary"), foreground: token("primary-foreground") },
        secondary: { DEFAULT: token("secondary"), foreground: token("secondary-foreground") },
        muted: { DEFAULT: token("muted"), foreground: token("muted-foreground") },
        accent: { DEFAULT: token("accent"), foreground: token("accent-foreground") },
        destructive: { DEFAULT: token("destructive"), foreground: token("destructive-foreground") },
        border: token("border"),
        input: token("input"),
        ring: token("ring"),
        // The scrim behind a dialog; not a text surface, so outside check:contrast.
        overlay: token("overlay"),
        // Behind a logo made for a light page (#510); no text sits on it.
        "logo-plate": token("logo-plate"),
        // The bands of the bar of whom people seek (SeeksBar, #581); no text sits on them.
        seeks: {
          men: token("seeks-men"),
          everyone: token("seeks-everyone"),
          women: token("seeks-women"),
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      // The minimum touch target (CLAUDE.md Accessibility): min-h-touch min-w-touch.
      spacing: { touch: "44px" },
      // Two families (#408, ADR-052 §4): Saiga, Kuutti's typeface, through
      // `font-sans` for headings and controls, and the phone's own font through
      // `font-system` for everything read, the Text primitive's default. A phone
      // takes the first family only (NativeWind keeps one): iOS knows "System",
      // and Android draws a family it does not know in its system font, as a
      // build without Saiga draws Saiga's text. The web reads the whole stack,
      // for a browser without Saiga and for a character it lacks (✓).
      fontFamily: {
        sans: ["Saiga", "system-ui", "-apple-system", "'Segoe UI'", "Roboto", "sans-serif"],
        system: ["System", "system-ui", "-apple-system", "'Segoe UI'", "Roboto", "sans-serif"],
      },
      // The type scale (#408): points on a phone and pixels on the web, which
      // the rem-based sizes were not (rem 14 on a phone, 16 on the web). Saiga
      // Regular is as dark as the system font's Semibold, so the variants of
      // the Text primitive name Saiga's weight for each role.
      fontSize: {
        h1: ["30px", { lineHeight: "36px", letterSpacing: "-0.3px" }],
        h2: ["24px", { lineHeight: "30px" }],
        // h3 and the title of a card or a dialog.
        title: ["20px", { lineHeight: "26px" }],
        // What is read, in the phone's font.
        body: ["17px", { lineHeight: "25px" }],
        // One line at body size: a button's words, h4.
        control: ["17px", { lineHeight: "22px" }],
        // Saiga's small words: a field's label, a chip, the heading of a group.
        label: ["15px", { lineHeight: "20px", letterSpacing: "0.15px" }],
        // Secondary text, in the phone's font.
        small: ["15px", { lineHeight: "20px" }],
        caption: ["13px", { lineHeight: "18px" }],
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
