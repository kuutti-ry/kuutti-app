/**
 * check-docs: a change to what a document draws redraws it, or says it is
 * still true (ADR-047).
 *
 * - A document that draws the code names the files it draws in a block under
 *   its title, one path from the repository's root per line, a trailing `/`
 *   for a folder and everything in it:
 *
 *       <!-- draws
 *       apps/api/src/chat/ws.ts
 *       infra/modules/media/
 *       -->
 *
 * - Every view of docs/architecture/ has one (#397), its README aside, and so
 *   does the register of decisions (#396). Another folder or file joins
 *   REQUIRED in the change that lands it.
 * - Fails on a required document without a block, a path in a block that is
 *   not in the repository (a rename or a removal changes what is drawn), and a
 *   drawn file this change touches while its document is neither touched nor
 *   named on a `Still-true: <document>` line of one of the change's commit
 *   messages. That line says its author looked and nothing the document draws
 *   has changed; it is the `Unwalked:` line's kind (.claude/rules/mobile.md).
 * - What it cannot see is whether a drawing is right: review does that.
 *
 * The change is everything since --base (default: where HEAD left
 * origin/main), the working tree's own edits included, and its messages are
 * the commits since then. CI passes HEAD^1, the merge commit's first parent.
 *
 * Usage: node scripts/check-docs.ts [--base <commit>] [--self-test]
 * No dependencies. Needs Node 22.18+ (type stripping).
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Doc = { file: string; draws: string[] | undefined };

const ROOT = join(import.meta.dirname, "..");
// As in a block: a trailing `/` is a folder and everything in it.
const REQUIRED = ["docs/architecture/", "docs/decisions.md"];
// Right under the title, so a block quoted further down is no block.
const BLOCK = /^# [^\n]*\n\s*<!--\s*draws\s*\n([\s\S]*?)-->/;
const STILL_TRUE = /^still-true:(.*)$/gim;
const TEST = /\.test\.tsx?$/;

function drawsOf(text: string): string[] | undefined {
  const block = BLOCK.exec(text)?.[1];
  if (block === undefined) return undefined;
  return block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function stillTrue(messages: string): Set<string> {
  const named = new Set<string>();
  for (const line of messages.matchAll(STILL_TRUE)) {
    for (const file of (line[1] ?? "").split(/[\s,]+/)) {
      if (file.endsWith(".md")) named.add(file);
    }
  }
  return named;
}

function drawn(path: string, entry: string): boolean {
  return entry.endsWith("/") ? path.startsWith(entry) : path === entry;
}

function problemsOf(
  docs: Doc[],
  exists: (entry: string) => boolean,
  changed: string[],
  messages: string,
): string[] {
  const problems: string[] = [];
  const touched = new Set(changed);
  const named = stillTrue(messages);
  for (const doc of docs) {
    if (doc.draws === undefined) {
      const required = REQUIRED.some((entry) => drawn(doc.file, entry));
      if (required && !doc.file.endsWith("/README.md")) {
        problems.push(`${doc.file} has no "<!-- draws" block: name the files it draws`);
      }
      continue;
    }
    for (const entry of doc.draws) {
      if (!exists(entry)) {
        problems.push(
          `${doc.file} draws ${entry}, which is not in the repository: redraw the view for the rename or the removal, and its block with it`,
        );
      }
    }
    if (touched.has(doc.file) || named.has(doc.file)) continue;
    // A test checks what is drawn and draws nothing itself.
    const hits = changed.filter(
      (path) => !TEST.test(path) && doc.draws?.some((entry) => drawn(path, entry)),
    );
    if (hits.length > 0) {
      problems.push(
        `${doc.file} draws what this change touches (${hits.join(", ")}):\n    redraw it and its steps, or, if nothing it draws has changed, add this line to a commit message:\n    Still-true: ${doc.file}`,
      );
    }
  }
  return problems;
}

function selfTest(): void {
  const view = "docs/architecture/chat.md";
  const docs: Doc[] = [
    { file: view, draws: ["apps/api/src/chat/ws.ts", "infra/modules/media/"] },
    { file: "docs/architecture/README.md", draws: undefined },
  ];
  const all = () => true;
  const cases: Array<[string, Doc[], (entry: string) => boolean, string[], string, string[]]> = [
    ["nothing drawn changes", docs, all, ["apps/api/src/app.ts"], "", []],
    ["a drawn file changes", docs, all, ["apps/api/src/chat/ws.ts"], "", [`${view} draws`]],
    [
      "a file in a drawn folder changes",
      docs,
      all,
      ["infra/modules/media/main.tf"],
      "",
      [`${view} draws`],
    ],
    ["a sibling of a drawn file", docs, all, ["apps/api/src/chat/ws.test.ts"], "", []],
    ["a test in a drawn folder", docs, all, ["infra/modules/media/x.test.ts"], "", []],
    ["the view is redrawn", docs, all, ["apps/api/src/chat/ws.ts", view], "", []],
    [
      "the view is said still true",
      docs,
      all,
      ["apps/api/src/chat/ws.ts"],
      `x\n\nStill-true: ${view}\n`,
      [],
    ],
    ["the line in another case", docs, all, ["apps/api/src/chat/ws.ts"], `still-TRUE: ${view}`, []],
    [
      "two views on one line",
      [...docs, { file: "docs/architecture/b.md", draws: ["biome.json"] }],
      all,
      ["apps/api/src/chat/ws.ts", "biome.json"],
      `Still-true: ${view}, docs/architecture/b.md (a log line only)`,
      [],
    ],
    [
      "another view said still true",
      docs,
      all,
      ["apps/api/src/chat/ws.ts"],
      "Still-true: docs/architecture/other.md",
      [`${view} draws`],
    ],
    [
      "the line only quoted mid-line",
      docs,
      all,
      ["apps/api/src/chat/ws.ts"],
      `see Still-true: ${view}`,
      [`${view} draws`],
    ],
    [
      "a drawn path that is gone",
      docs,
      (entry) => entry !== "apps/api/src/chat/ws.ts",
      [],
      "",
      [`${view} draws apps/api/src/chat/ws.ts, which is not in the repository`],
    ],
    [
      "a view without a block",
      [{ file: "docs/architecture/new.md", draws: undefined }],
      all,
      [],
      "",
      ['docs/architecture/new.md has no "<!-- draws" block'],
    ],
    [
      "the register without a block",
      [{ file: "docs/decisions.md", draws: undefined }],
      all,
      [],
      "",
      ['docs/decisions.md has no "<!-- draws" block'],
    ],
    [
      "a document elsewhere without one",
      [{ file: "docs/runbooks/x.md", draws: undefined }],
      all,
      [],
      "",
      [],
    ],
  ];
  for (const [name, given, exists, changed, messages, expected] of cases) {
    const problems = problemsOf(given, exists, changed, messages);
    const matches =
      problems.length === expected.length &&
      expected.every((start, i) => problems[i]?.startsWith(start));
    if (!matches) {
      console.error(`✖ self-test, ${name}: expected ${JSON.stringify(expected)}`);
      console.error(`  got ${JSON.stringify(problems)}`);
      process.exit(1);
    }
  }
  const block = "# T\n\n<!-- draws\napps/a.ts\n\n  infra/b/\n-->\n";
  const quoted = "# T\n\nText.\n\n```\n<!-- draws\napps/a.ts\n-->\n```\n";
  const parsed = [drawsOf(block), drawsOf("# T\n"), drawsOf(quoted)];
  if (JSON.stringify(parsed) !== '[["apps/a.ts","infra/b/"],null,null]') {
    console.error(`✖ self-test, the block's parse: got ${JSON.stringify(parsed)}`);
    process.exit(1);
  }
  console.log(`✔ check-docs self-test: ${cases.length + 1} cases`);
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function markdownUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".md"))
    .map((file) => `${dir}/${file}`)
    .sort();
}

function exists(entry: string): boolean {
  try {
    const stat = statSync(join(ROOT, entry));
    return entry.endsWith("/") ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

if (process.argv.includes("--self-test")) selfTest();

const flag = process.argv.indexOf("--base");
const base = flag === -1 ? "origin/main" : process.argv[flag + 1];
if (base === undefined || base.startsWith("--")) {
  console.error("✖ --base needs a commit");
  process.exit(2);
}
const from = git(["merge-base", base, "HEAD"]).trim();
const changed = git(["diff", "--name-only", "--no-renames", from]).split("\n").filter(Boolean);
const messages = git(["log", "--format=%B", `${from}..HEAD`]);
const docs: Doc[] = markdownUnder("docs").map((file) => ({
  file,
  draws: drawsOf(readFileSync(join(ROOT, file), "utf8")),
}));
const problems = problemsOf(docs, exists, changed, messages);
for (const problem of problems) console.error(`✖ ${problem}`);
if (problems.length > 0) process.exit(1);
const drawing = docs.filter((doc) => doc.draws !== undefined).length;
console.log(
  `✔ check-docs: ${drawing} documents name what they draw; ${changed.length} files changed since ${from.slice(0, 8)}, every drawing they touch redrawn or still true`,
);
