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
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      // The minimum touch target (CLAUDE.md Accessibility): min-h-touch min-w-touch.
      spacing: { touch: "44px" },
      // Saiga, Kuutti's typeface (ADR-052), through `font-sans` on the text
      // primitives. A phone takes the first family only (NativeWind keeps one)
      // and draws in the system font when its build has no Saiga; the web reads
      // the whole stack, for a browser without Saiga and for a character it
      // lacks (✓).
      fontFamily: {
        sans: ["Saiga", "system-ui", "-apple-system", "'Segoe UI'", "Roboto", "sans-serif"],
      },
      // Saiga has no 600. Bold, as the website draws its 650 (its decision 18),
      // and the same face on every platform, where each would pick its own.
      fontWeight: { semibold: "700" },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
