/**
 * Part of `pnpm lint` (#13): no user-facing string literal in the clients'
 * TSX. Every such string is a key of messages.yaml, rendered through t().
 * Tests are exempt (they assert on rendered text), and so is this package.
 * Since #150 the same pass refuses a date formatted outside this package
 * (`toLocaleDateString`, `Intl.DateTimeFormat`, `dateStyle`): every date on
 * a screen is d.M.yyyy through formatDate, formatDateTime or formatTime.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { findUiStrings } from "./lib/ui-strings.ts";

const repo = resolve(import.meta.dirname, "..", "..", "..");
const ROOTS = ["apps/mobile/app", "apps/mobile/src", "apps/admin/src"];
const annotate = process.env.GITHUB_ACTIONS === "true";

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "test" ? [] : tsxFiles(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

const DATE_OUTSIDE_I18N =
  /\b(toLocaleDateString|toLocaleTimeString|toLocaleString|toDateString|toUTCString)\s*\(|Intl\.DateTimeFormat|\bdateStyle\s*:|\btimeStyle\s*:/g;

/** Where a client formats a date itself, by line and column; a comment may name the API, code may not. */
function dateHits(source: string): { line: number; column: number; text: string }[] {
  const hits: { line: number; column: number; text: string }[] = [];
  const lines = source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n");
  lines.forEach((line, index) => {
    const text = line.replace(/^\s*\/\/.*$/, "");
    for (const match of text.matchAll(DATE_OUTSIDE_I18N)) {
      hits.push({ line: index + 1, column: (match.index ?? 0) + 1, text: match[0] });
    }
  });
  return hits;
}

let count = 0;
let files = 0;
for (const root of ROOTS) {
  for (const path of tsxFiles(join(repo, root))) {
    files++;
    const file = relative(repo, path);
    const source = readFileSync(path, "utf8");
    const report = (line: number, column: number, message: string) => {
      count++;
      console.error(
        annotate
          ? `::error file=${file},line=${line},col=${column}::${message}`
          : `✖ ${file}:${line}:${column} ${message}`,
      );
    };
    if (/\.tsx$/.test(path)) {
      for (const hit of findUiStrings(file, source)) {
        report(
          hit.line,
          hit.column,
          `inline string ${JSON.stringify(hit.text)} (${hit.where}): add a key to packages/i18n/messages.yaml and use t()`,
        );
      }
    }
    for (const hit of dateHits(source)) {
      report(
        hit.line,
        hit.column,
        `date formatted outside @kuutti/i18n (${hit.text}): use formatDate, formatDateTime or formatTime, d.M.yyyy on every screen`,
      );
    }
  }
}
if (count > 0) process.exit(1);
console.log(
  `✔ check:ui-strings: ${files} files, no inline user-facing strings, no date formatted outside @kuutti/i18n`,
);
