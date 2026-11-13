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
import ts from "typescript";
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

const DATE_METHODS = new Set([
  "toLocaleDateString",
  "toLocaleTimeString",
  "toLocaleString",
  "toDateString",
  "toTimeString",
  "toUTCString",
  "DateTimeFormat",
]);

/** Read syntax, so comment markers inside strings cannot hide the next call. */
function dateHits(source: string): { line: number; column: number; text: string }[] {
  const file = ts.createSourceFile(
    "client.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const hits: { line: number; column: number; text: string }[] = [];
  const nameOf = (node: ts.Node): string | undefined => {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression))
      return node.argumentExpression.text;
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    const call = ts.isCallExpression(node) || ts.isNewExpression(node);
    const name = call
      ? nameOf(node.expression)
      : ts.isPropertyAssignment(node)
        ? nameOf(node.name)
        : undefined;
    if (
      name &&
      ((call && DATE_METHODS.has(name)) || (!call && ["dateStyle", "timeStyle"].includes(name)))
    ) {
      const target = call ? node.expression : (node as ts.PropertyAssignment).name;
      const marked =
        call && ts.isPropertyAccessExpression(target) && name !== "DateTimeFormat"
          ? target.name
          : target;
      const position = file.getLineAndCharacterOfPosition(marked.getStart(file));
      hits.push({
        line: position.line + 1,
        column: position.character + 1,
        text: call ? (name === "DateTimeFormat" ? target.getText(file) : `${name}(`) : `${name}:`,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
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
