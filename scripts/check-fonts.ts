/**
 * check-fonts: no font file in this repository, ever (ADR-052, #394).
 *
 * Saiga, Kuutti's typeface, is licensed to Kuutti ry for the Kuutti app and
 * the media of its brand, and its files are never public as sources. This
 * repository is public, and a file once pushed stays reachable for good: a
 * squash merge leaves the pull request's commits at refs/pull/<n>/head, and
 * main is never rewritten. So this reads what git holds, by content and not
 * only by name, and refuses
 * - a font by its first bytes: WOFF2, WOFF, or an sfnt (TrueType, OpenType,
 *   a collection) whose table directory fits the file;
 * - an archive, which can carry one: zip, gzip, 7z, rar, xz, bzip2, zstd,
 *   lz4, lzip, compress, tar;
 * - a font written into a file as a data URL;
 * - a file whose SHA-256 is one Spoke delivered (scripts/saiga.json);
 * - a name with a font's extension.
 * No font is allowed, an open one neither: the app needs none in git.
 *
 *   node scripts/check-fonts.ts                 what the index holds: tracked and staged
 *                                               (pnpm lint, .githooks/pre-commit)
 *   node scripts/check-fonts.ts --range <a..b>  every file the commits of a range bring
 *                                               (CI over a pull request's commits)
 *   node scripts/check-fonts.ts --new <commit> [--remote <name>]
 *                                               every file a push brings that the remote
 *                                               pushed to does not have (.githooks/pre-push)
 *   node scripts/check-fonts.ts --self-test
 * A font that got pushed anyway: the maintainer asks GitHub Support to purge it
 * (ADR-052). No dependencies. Needs Node 22.18+ (type stripping).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Blob = { oid: string; path: string };

const ROOT = join(import.meta.dirname, "..");
const DELIVERED = new Set(
  (
    JSON.parse(readFileSync(join(import.meta.dirname, "saiga.json"), "utf8")) as {
      delivered: string[];
    }
  ).delivered,
);
const EXTENSION = /\.(?:otf|ttf|ttc|otc|woff2?|eot|fon|fnt|pfa|pfb|pfm|afm|dfont)$/i;
/** sfnt versions: TrueType, OpenType with CFF, Apple's TrueType, PostScript in sfnt. */
const SFNT = new Set(["00010000", "4f54544f", "74727565", "74797031"]);
const ARCHIVES: Array<[string, string]> = [
  ["504b0304", "a zip archive"],
  ["504b0506", "a zip archive"],
  ["1f8b", "a gzip archive"],
  ["377abcaf271c", "a 7z archive"],
  ["52617221", "a rar archive"],
  ["fd377a585a00", "an xz archive"],
  ["425a68", "a bzip2 archive"],
  ["28b52ffd", "a zstd archive"],
  ["04224d18", "an lz4 archive"],
  ["4c5a4950", "an lzip archive"],
  ["1f9d", "a compress archive"],
];
// Written so that this file does not find itself: a data URL whose type is a font.
const INLINED = new RegExp(
  ["data", ":(?:font/|application/(?:x-)?font|application/vnd\\.ms-fontobject)"].join(""),
  "i",
);

/** What is wrong with a file git holds, or null. */
function fontProblem(path: string, bytes: Buffer): string | null {
  if (EXTENSION.test(path)) return `${path}: a font's name`;
  const head = bytes.subarray(0, 8).toString("hex");
  if (head.startsWith("774f4632") || head.startsWith("774f4646")) return `${path}: a font file`;
  if (head.startsWith("74746366")) return `${path}: a font collection`;
  // An sfnt names its tables right after its version; a text file that
  // happens to start with "true" does not have a directory that fits.
  if (SFNT.has(head.slice(0, 8)) && bytes.length >= 12) {
    const tables = bytes.readUInt16BE(4);
    if (tables > 0 && tables < 64 && bytes.length >= 12 + 16 * tables)
      return `${path}: a font file`;
  }
  for (const [magic, what] of ARCHIVES) if (head.startsWith(magic)) return `${path}: ${what}`;
  if (bytes.length > 262 && bytes.subarray(257, 262).toString("latin1") === "ustar") {
    return `${path}: a tar archive`;
  }
  if (DELIVERED.has(createHash("sha256").update(bytes).digest("hex"))) {
    return `${path}: a file of Saiga`;
  }
  if (INLINED.test(bytes.toString("latin1"))) return `${path}: a font written into the file`;
  return null;
}

function git(args: string[], input?: string): Buffer {
  return execFileSync("git", args, { cwd: ROOT, input, maxBuffer: 1 << 30 });
}

/** The blobs of the index, staged content included: `git ls-files -s`. */
function indexBlobs(): Blob[] {
  return (
    git(["ls-files", "-s", "-z"])
      .toString("utf8")
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => {
        const [meta = "", path = ""] = entry.split("\t");
        const [mode = "", oid = ""] = meta.split(" ");
        return { mode, oid, path };
      })
      // A submodule's entry names a commit of another repository, not a file here.
      .filter(({ mode, oid }) => oid !== "" && mode !== "160000")
      .map(({ oid, path }) => ({ oid, path }))
  );
}

/** The blobs the given revisions bring: `git rev-list --objects`, trees and commits left out. */
function revisionBlobs(revisions: string[]): Blob[] {
  const listed = git(["rev-list", "--objects", ...revisions])
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "");
  const oids = listed.map((line) => line.split(" ")[0] ?? "");
  const types = git(["cat-file", "--batch-check=%(objecttype)"], `${oids.join("\n")}\n`)
    .toString("utf8")
    .split("\n");
  return listed.flatMap((line, i) => {
    if (types[i] !== "blob") return [];
    const space = line.indexOf(" ");
    return [
      space === -1
        ? { oid: line, path: "" }
        : { oid: line.slice(0, space), path: line.slice(space + 1) },
    ];
  });
}

/** Every blob's content, in one `git cat-file --batch`. */
function problemsOf(blobs: Blob[]): string[] {
  if (blobs.length === 0) return [];
  const out = git(["cat-file", "--batch"], `${blobs.map(({ oid }) => oid).join("\n")}\n`);
  const problems: string[] = [];
  let at = 0;
  for (const { path } of blobs) {
    const eol = out.indexOf(0x0a, at);
    const header = out.subarray(at, eol).toString("utf8");
    const size = Number(header.split(" ")[2]);
    // Anything but "<oid> blob <size>" would shift every file after it: stop instead.
    if (header.split(" ")[1] !== "blob" || !Number.isInteger(size)) {
      throw new Error(`git cat-file answered "${header}" for ${path}`);
    }
    const bytes = out.subarray(eol + 1, eol + 1 + size);
    at = eol + 1 + size + 1;
    const problem = fontProblem(path, bytes);
    if (problem !== null) problems.push(problem);
  }
  return problems;
}

function selfTest(): void {
  const sfnt = (version: string, tables: number, length: number): Buffer => {
    const bytes = Buffer.alloc(length);
    bytes.write(version, 0, "hex");
    bytes.writeUInt16BE(tables, 4);
    return bytes;
  };
  const tar = Buffer.alloc(600);
  tar.write("ustar", 257, "latin1");
  const cases: Array<[string, string, Buffer, string | null]> = [
    ["a source file", "src/a.ts", Buffer.from("export const a = 1;\n"), null],
    ["a picture", "assets/icon.png", Buffer.from("89504e470d0a1a0a0000", "hex"), null],
    ["a text that starts with true", "x.txt", Buffer.from("true\nfalse\n"), null],
    ["a font's name", "assets/Any.WOFF2", Buffer.from("x"), "a font's name"],
    ["WOFF2 renamed", "a.bin", Buffer.from("774f4632000100000000", "hex"), "a font file"],
    ["WOFF renamed", "a.bin", Buffer.from("774f4646000100000000", "hex"), "a font file"],
    ["TrueType renamed", "a.png", sfnt("00010000", 12, 400), "a font file"],
    ["OpenType renamed", "a.png", sfnt("4f54544f", 10, 400), "a font file"],
    ["a collection", "a.bin", Buffer.from("74746366000100000000", "hex"), "a font collection"],
    ["a short file that starts like an sfnt", "a.bin", sfnt("00010000", 12, 40), null],
    ["a zip", "fonts.bin", Buffer.from("504b030414000000", "hex"), "a zip archive"],
    ["a gzip", "fonts.tgz.txt", Buffer.from("1f8b0800", "hex"), "a gzip archive"],
    ["a zstd", "fonts.bin", Buffer.from("28b52ffd0058", "hex"), "a zstd archive"],
    ["an lz4", "fonts.bin", Buffer.from("04224d186440", "hex"), "an lz4 archive"],
    ["a tar", "fonts", tar, "a tar archive"],
    [
      "an inlined font",
      "a.css",
      Buffer.from(`@font-face{src:url(${["data", ":font/woff2;base64,AAAA"].join("")})}`),
      "a font written into the file",
    ],
    [
      "an inlined font, the old type",
      "a.css",
      Buffer.from(`src:url(${["data", ":application/x-font-ttf;base64,AA"].join("")})`),
      "a font written into the file",
    ],
    ["a font named in CSS by its URL", "a.css", Buffer.from("src:url(/fonts/x.woff2)"), null],
  ];
  for (const [name, path, bytes, expected] of cases) {
    const problem = fontProblem(path, bytes);
    const holds = expected === null ? problem === null : problem === `${path}: ${expected}`;
    if (!holds) {
      console.error(`✖ self-test, ${name}: expected ${expected}, got ${problem}`);
      process.exit(1);
    }
  }
  // A file of Saiga is known by its SHA-256 alone; its bytes are never here.
  const [delivered] = DELIVERED;
  if (DELIVERED.size !== 36 || delivered === undefined || !/^[0-9a-f]{64}$/.test(delivered)) {
    console.error("✖ self-test: scripts/saiga.json does not list the 36 files Spoke delivered");
    process.exit(1);
  }
  console.log(`✔ check-fonts self-test: ${cases.length + 1} cases`);
}

if (process.argv.includes("--self-test")) selfTest();

const range = process.argv.indexOf("--range");
const fresh = process.argv.indexOf("--new");
let blobs: Blob[];
let what: string;
if (range !== -1 || fresh !== -1) {
  const value = process.argv[(range !== -1 ? range : fresh) + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`✖ ${range !== -1 ? "--range" : "--new"} needs a value`);
    process.exit(2);
  }
  // Only what the remote pushed to has: another remote's history, a private
  // repository fetched into this clone, is not public by being there.
  const at = process.argv.indexOf("--remote");
  const remote = at === -1 ? undefined : process.argv[at + 1];
  const revisions =
    range !== -1 ? [value] : [value, "--not", remote ? `--remotes=${remote}` : "--remotes"];
  blobs = revisionBlobs(revisions);
  what = range !== -1 ? `the commits of ${value}` : "this push";
} else {
  blobs = indexBlobs();
  what = "the index";
}
const problems = problemsOf(blobs);
if (problems.length > 0) {
  for (const problem of problems) console.error(`✖ ${problem}`);
  console.error(
    "No font file is ever in this repository, Saiga's least of all (ADR-052): unstage it (git rm --cached <file>), or drop the commit that brought it before it is pushed.",
  );
  process.exit(1);
}
console.log(`✔ check-fonts: ${blobs.length} files of ${what}, no font among them`);
