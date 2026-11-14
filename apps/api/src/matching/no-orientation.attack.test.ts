import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { attack } from "../test/attack.ts";
import { identifierWords } from "../test/sources.ts";

// Attacks on the guard of no-orientation.test.ts (#380): "no source of the
// apps, and no text of the catalogue, names one", in a form or a place its
// search may not read. The guard keeps its pattern and its folders to itself,
// so they are cut from its file here: the attacks ask what the guard asks.
// The guard also reads this file, so no word it looks for is written here, and
// every other word for the same thing is written in parts.

const guard = readFileSync(new URL("./no-orientation.test.ts", import.meta.url), "utf8");

function regexOf(name: string): RegExp {
  const [, source, flags] = new RegExp(`const ${name}\\s*=\\s*/(.+)/([a-z]*);`).exec(guard) ?? [];
  if (source === undefined) throw new Error(`no ${name} in no-orientation.test.ts`);
  return new RegExp(source, flags);
}
const ORIENTATION = regexOf("ORIENTATION");
const SOURCE = regexOf("SOURCE");
const SCANNED = [
  ...(/const SCANNED = \[([^\]]+)\]/.exec(guard)?.[1] ?? "").matchAll(/"([^"]+)"/g),
].map((match) => match[1] ?? "");

// The words themselves, taken from the guard's own list, in its order.
const [first = "", second = "", third = "", , fifth = ""] = (
  /\(([^)]+)\)/.exec(ORIENTATION.source)?.[1] ?? ""
).split("|");
const capital = (word: string) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
const parts = (...of: string[]) => of.join("");

// These forms now hold the same rule as their ordinary spellings (#380).

/**
 * What is tried, a line that names an orientation, the same line naming
 * something else, and whether it goes through today.
 */
const NAMED: [string, string, string, string?][] = [
  // The search is for seven English words, each as a whole word: a letter, a
  // digit or an underscore beside one hides it, and so does another language.
  [
    "in the plural",
    `const labels = ["${first}s", "${second}s"];`,
    'const labels = ["days", "weeks"];',
  ],
  ["as the noun", `const label = "${fifth}ity";`, 'const label = "hospitality";'],
  [
    "in a camel-case name",
    `const is${capital(first)} = seeks.includes(own);`,
    "const isDay = seeks.includes(own);",
  ],
  ["in a snake-case name", `const inferred_${second} = true;`, "const inferred_weekday = true;"],
  ["in a constant's name", `const ${third.toUpperCase()}_LABEL = 3;`, "const WEEKDAY_LABEL = 3;"],
  ["in Finnish", `  fi: "${parts("b", "i", "seksuaali")}"`, '  fi: "viikonpäivä"'],
  ["in Finnish, by the short word", `  fi: "${parts("ho", "mo")}"`, '  fi: "talo"'],
  ["in Swedish", `  sv: "${parts("ho", "mo", "sexuell")}"`, '  sv: "veckodag"'],
  [
    "by the short word the guard's own header uses",
    `const label = seeksBoth ? "${parts("b", "i")}" : null;`,
    'const label = seeksBoth ? "both" : null;',
  ],
  // Forms the search has to read like the plain ones.
  ["with a capital", `const label = "${capital(first)}";`, 'const label = "Day";'],
  ["in capitals", `const label = "${second.toUpperCase()}";`, 'const label = "WEEKDAY";'],
  ["as a property", `const label = labels.${first};`, "const label = labels.day;"],
  ["before a hyphen", `const label = "${third}-or-not";`, 'const label = "weekday-or-not";'],
];

for (const [name, named, harmless, open] of NAMED) {
  attack(`orientation: one named ${name} passes`, {
    attempt: () => {
      // The guard's list still starts with the five words the cases are built from.
      expect([first, second, third, fifth].every((word) => ORIENTATION.test(word))).toBe(true);
      return ORIENTATION.test(identifierWords(named));
    },
    control: () => ORIENTATION.test(identifierWords(harmless)),
    succeeds: (seen) => expect(seen).toBe(false),
    open,
  });
}

// What the guard opens: a file under one of its folders, of a kind it reads,
// outside the two folder names its walk passes over.
const read = (path: string) =>
  SCANNED.some((root) => path === root || path.startsWith(`${root}/`)) &&
  SOURCE.test(path) &&
  !path.split("/").some((part) => part === "node_modules" || part === "generated");

/** What is tried, a file of the apps, and whether it goes through today. */
const PLACES: [string, string, string?][] = [
  // The guard opens .ts, .tsx and .yaml under three folders, and the catalogue.
  ["a screen's route", "apps/mobile/app/(tabs)/you.tsx"],
  ["a command line of the API's", "apps/api/scripts/demo-stories.ts"],
  ["a list of labels kept as JSON", "apps/mobile/src/features/profile/labels.json"],
  // Places the guard has to read like the plain ones.
  ["a screen of the panel", "apps/admin/src/features/safety/Person.tsx"],
  ["a test's helper of the API's", "apps/api/src/test/people.ts"],
];

for (const [name, path, open] of PLACES) {
  attack(`orientation: ${name} is not read`, {
    attempt: () => read(path),
    // A dependency's file: rightly not read.
    control: () => read("apps/api/src/node_modules/x/index.ts"),
    succeeds: (seen) => expect(seen).toBe(false),
    open,
  });
}
