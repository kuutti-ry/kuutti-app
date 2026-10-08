import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Nothing is ever derived from whom a person seeks (#147, TD-14, ADR-019 §6):
// a woman seeking women and men may be bi, pan, queer or nothing, and a label
// the app computed would be an inference of article 9 data with no matching
// value. So no source of the apps, and no text of the catalogue, names one.
// "queer" is not in the list ("genderqueer" is a label a person may choose), nor
// "straight", which the code uses in its plain sense.

const ROOT = resolve(import.meta.dirname, "../../../..");
const SCANNED = [
  "apps/api/src",
  "apps/mobile/src",
  "apps/admin/src",
  "packages/i18n/messages.yaml",
];
const ORIENTATION = /\b(gay|lesbian|bisexual|heterosexual|homosexual|pansexual|asexual)\b/i;
const SOURCE = /\.(ts|tsx|yaml)$/;
const SELF = resolve(import.meta.filename);

function* files(path: string): Generator<string> {
  const stat = statSync(path);
  if (stat.isFile()) {
    if (SOURCE.test(path) && path !== SELF) yield path;
    return;
  }
  for (const name of readdirSync(path)) {
    if (name === "node_modules" || name === "generated") continue;
    yield* files(join(path, name));
  }
}

describe("orientation", () => {
  it("is named nowhere in the apps or the catalogue: nothing is derived from whom one seeks", () => {
    const found: string[] = [];
    for (const dir of SCANNED) {
      for (const file of files(resolve(ROOT, dir))) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, index) => {
          if (ORIENTATION.test(line))
            found.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
        });
      }
    }
    expect(found).toEqual([]);
  });
});
