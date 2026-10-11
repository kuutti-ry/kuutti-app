/** @type {import("jest").Config} */
module.exports = {
  preset: "jest-expo",
  // jest-expo owns apps/mobile; Vitest owns apps/api and packages/* (CLAUDE.md Testing).
  testMatch: ["<rootDir>/src/**/*.test.(ts|tsx)", "<rootDir>/app/**/*.test.(ts|tsx)"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  // `pnpm test:coverage` counts every source file, the ones no test loads too.
  collectCoverageFrom: [
    "src/**/*.{ts,tsx}",
    "app/**/*.{ts,tsx}",
    "!**/*.test.{ts,tsx}",
    "!**/*.d.ts",
    "!src/test/**",
  ],
  coverageReporters: ["text", "json-summary"],
  // ADR-021's floor, just below what the app reached on 2026-10-11 (#235); up when the code allows.
  coverageThreshold: { global: { branches: 96, lines: 99, functions: 99, statements: 99 } },
  // lucide ships its per-icon modules as .mjs, which the preset's transform
  // pattern does not cover.
  transform: { "\\.mjs$": "babel-jest" },
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|lucide-react-native|nativewind|react-native-css-interop|@rn-primitives/.*|react-native-reanimated|react-native-worklets|i18next|i18next-icu|react-i18next|intl-messageformat|@formatjs/.*)",
  ],
};
