/**
 * `pnpm check:legal-versions [--file <versions.json>]`: the app's consent
 * versions against the site's (#208, ADR-010 §4), in CI's i18n job.
 *
 * Reads https://kuutti.app/legal/versions.json, which the site's build writes,
 * or a local copy with --file (the site's dist/ before it is deployed, a
 * fixture), and fails when a kind's version in CONSENT_VERSIONS is not the
 * site's, when either side lacks a kind, when the app's link to a text is
 * not the address the site publishes, or when the site's research or
 * sensitive-answers text is not this app's Finnish wording of it. A document
 * that cannot be read fails too, after three tries on a network failure or a
 * 5xx: nothing passes on a 404. The mirror is the site's own
 * `pnpm check:app-versions`, which reads src/generated/consent.ts on main.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CONSENT_VERSIONS } from "../src/generated/consent.ts";
import { fi } from "../src/generated/fi.ts";
import { commandData } from "./lib/annotate.ts";
import {
  fetchPublished,
  legalVersionProblems,
  type Published,
  parsePublished,
  VERSIONS_URL,
} from "./lib/legal-versions.ts";

const annotate = process.env.GITHUB_ACTIONS === "true";
const say = (message: string) =>
  console.error(annotate ? `::error::${commandData(message)}` : `✖ ${message}`);

function fail(message: string): never {
  say(message);
  process.exit(1);
}

// Strict, so a misspelt option or `--file` with no value stops here rather
// than checking the deployed file instead of the one named (#235). pnpm
// passes the `--` of `pnpm check:legal-versions -- --file x` through.
const { file } = parseArgs({
  args: process.argv.slice(2).filter((arg, i) => !(arg === "--" && i === 0)),
  options: { file: { type: "string" } },
}).values;
if (file === "") fail("--file takes a value");

const source = file ?? VERSIONS_URL;
let published: Published;
try {
  published =
    file === undefined ? await fetchPublished() : parsePublished(readFileSync(file, "utf8"));
} catch (error) {
  fail(`the site's versions (${source}) could not be read: ${(error as Error).message}`);
}

const problems = legalVersionProblems(CONSENT_VERSIONS, published, fi);
for (const problem of problems) say(problem);
if (problems.length > 0) {
  console.error(
    `✖ check:legal-versions: the app's consent versions are not the site's (${source})`,
  );
  process.exit(1);
}
console.log(
  `✔ check:legal-versions: the app's consent versions are the site's (${source}): ` +
    Object.entries(CONSENT_VERSIONS)
      .map(([kind, version]) => `${kind} ${version}`)
      .join(", "),
);
