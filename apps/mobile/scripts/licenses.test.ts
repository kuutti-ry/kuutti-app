import { readFileSync } from "node:fs";
import { collectLicenses, OUTPUT, renderLicenses } from "./licenses";

describe("the licences of the packages (#143)", () => {
  const entries = collectLicenses();

  it("names the packages this build is made of, each with a licence", () => {
    const names = new Set(entries.map((e) => e.name));
    const missing = ["expo", "react-native", "react", "expo-router"].filter((n) => !names.has(n));
    expect(missing).toEqual([]);
    expect(entries.filter((e) => e.license === "").map((e) => e.name)).toEqual([]);
    expect(entries.filter((e) => e.name.startsWith("@kuutti/")).map((e) => e.name)).toEqual([]);
  });

  it("is what src/generated/licenses.json holds; stale? run pnpm --filter mobile licenses", () => {
    expect(readFileSync(OUTPUT, "utf8")).toBe(renderLicenses(entries));
  });
});
