/** One package of the build with its licence, as scripts/licenses.ts writes it. */
export type LicenseEntry = { name: string; version: string; license: string };

/**
 * The families a package belongs to by its name alone (#376), in the order
 * the licences screen shows them, so the generated list needs no mapping kept
 * by hand. A name is the family's own and is not translated; the first family
 * that owns a package takes it, so `react-native-svg` is React Native's, not
 * React's.
 */
const FAMILIES: ReadonlyArray<{ name: string; owns: (pkg: string) => boolean }> = [
  {
    name: "Expo",
    owns: (pkg) =>
      pkg === "expo" ||
      pkg.startsWith("expo-") ||
      pkg.startsWith("@expo/") ||
      pkg.startsWith("@expo-"),
  },
  {
    name: "React Native",
    owns: (pkg) =>
      pkg === "react-native" ||
      pkg.startsWith("react-native-") ||
      pkg.startsWith("@react-native/") ||
      pkg.startsWith("@react-native-"),
  },
  {
    name: "React",
    owns: (pkg) => pkg === "react" || pkg.startsWith("react-") || pkg.startsWith("@react-"),
  },
  { name: "Sentry", owns: (pkg) => pkg.startsWith("@sentry/") },
  { name: "FormatJS", owns: (pkg) => pkg.startsWith("@formatjs/") },
];

export type LicenseGroup = {
  /** The family's name, or null for the packages of no family, which come last. */
  family: string | null;
  entries: LicenseEntry[];
};

/** The packages in their families, each in the list's own order; a family with none is left out. */
export function licenseGroups(entries: readonly LicenseEntry[]): LicenseGroup[] {
  const groups: LicenseGroup[] = [
    ...FAMILIES.map(({ name }) => ({ family: name, entries: [] as LicenseEntry[] })),
    { family: null, entries: [] },
  ];
  for (const entry of entries) {
    const at = FAMILIES.findIndex(({ owns }) => owns(entry.name));
    groups[at === -1 ? FAMILIES.length : at]?.entries.push(entry);
  }
  return groups.filter((group) => group.entries.length > 0);
}
