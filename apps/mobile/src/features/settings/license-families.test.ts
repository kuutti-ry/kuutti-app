import LICENSES from "@/generated/licenses.json";
import { type LicenseEntry, licenseGroups } from "./license-families";

const entry = (name: string): LicenseEntry => ({ name, version: "1.0.0", license: "MIT" });
const names = (groups: ReturnType<typeof licenseGroups>) =>
  groups.map((g) => [g.family, g.entries.map((e) => e.name)]);

describe("the licences in families (#376)", () => {
  it("puts each package in the first family its name belongs to, the rest last, in the list's order", () => {
    const groups = licenseGroups(
      [
        "@expo/vector-icons",
        "@expo-google-fonts/inter",
        "@formatjs/icu-messageformat-parser",
        "@react-native-masked-view/masked-view",
        "@react-native/js-polyfills",
        "@react-navigation/native",
        "@sentry/core",
        "expo",
        "expo-router",
        "lucide-react-native",
        "react",
        "react-i18next",
        "react-native",
        "react-native-svg",
        "zod",
      ].map(entry),
    );
    expect(names(groups)).toEqual([
      ["Expo", ["@expo/vector-icons", "@expo-google-fonts/inter", "expo", "expo-router"]],
      [
        "React Native",
        [
          "@react-native-masked-view/masked-view",
          "@react-native/js-polyfills",
          "react-native",
          "react-native-svg",
        ],
      ],
      ["React", ["@react-navigation/native", "react", "react-i18next"]],
      ["Sentry", ["@sentry/core"]],
      ["FormatJS", ["@formatjs/icu-messageformat-parser"]],
      // Neither a name that only ends in a family's, nor one outside every family, is the family's.
      [null, ["lucide-react-native", "zod"]],
    ]);
  });

  it("leaves out a family with no package, and answers nothing for no packages", () => {
    expect(names(licenseGroups([entry("expolike"), entry("reactive")]))).toEqual([
      [null, ["expolike", "reactive"]],
    ]);
    expect(names(licenseGroups([entry("expo")]))).toEqual([["Expo", ["expo"]]]);
    expect(licenseGroups([])).toEqual([]);
  });

  it("keeps every package of this build once, with its licence", () => {
    const groups = licenseGroups(LICENSES);
    const flat = groups.flatMap((g) => g.entries);
    expect(flat).toHaveLength(LICENSES.length);
    expect(new Set(flat)).toEqual(new Set(LICENSES));
    expect(groups.at(-1)?.family).toBeNull();
  });
});
