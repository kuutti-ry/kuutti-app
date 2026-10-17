/**
 * `pnpm i18n:check [--release]`: the CI job (#13). Missing Finnish fails,
 * missing Swedish warns, a banned inflection or a missing plural form fails, a
 * translation without a machine flag or a current review fails (#55), and with
 * --release (a v* tag, a production EAS build) machine text in a released
 * language and draft legal text fail.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { commandData } from "./lib/annotate.ts";
import { checkMessages, stale, unreviewed } from "./lib/check.ts";
import { parseMessages } from "./lib/schema.ts";

// Strict, so `--release=`, `--release=true` or a misspelt `--relase` stops here
// rather than running the check without the release rules (#235). pnpm passes
// the `--` of `pnpm i18n:check -- --release` through; it is not an argument.
const { release } = parseArgs({
  args: process.argv.slice(2).filter((arg, i) => !(arg === "--" && i === 0)),
  options: { release: { type: "boolean", default: false } },
}).values;
const annotate = process.env.GITHUB_ACTIONS === "true";

let messages: ReturnType<typeof parseMessages>;
try {
  messages = parseMessages(
    readFileSync(resolve(import.meta.dirname, "..", "messages.yaml"), "utf8"),
  );
} catch (error) {
  console.error(`✖ ${(error as Error).message}`);
  process.exit(1);
}

const { errors, warnings } = checkMessages(messages, { release });
for (const warning of warnings)
  console.log(annotate ? `::warning::${commandData(warning)}` : `! ${warning}`);
for (const error of errors)
  console.error(annotate ? `::error::${commandData(error)}` : `✖ ${error}`);

const waitingFi = unreviewed(messages, "fi").length + stale(messages, "fi").length;
console.log(
  `${errors.length === 0 ? "✔" : "✖"} i18n:check${release ? " --release" : ""}: ` +
    `${Object.keys(messages).length} keys, ${errors.length} errors, ${warnings.length} warnings, ` +
    `${waitingFi} Finnish texts awaiting a native review (pnpm i18n:review)`,
);
if (errors.length > 0) process.exit(1);
