/**
 * The third-party packages a bundle is made of, with the texts their licences
 * ask to go with every copy (#416): the copyright lines, the licence text and
 * any NOTICE file. The phone app's licences screen
 * (apps/mobile/scripts/licenses.ts) and the API image's notices file
 * (apps/api/scripts/notices.ts) read them the same way.
 *
 * What ships is what the bundler put in the bundle, so the packages come from
 * the files it says it bundled: the phone's from Metro's source maps (#177),
 * the API's from esbuild's metafile. Each text is read from the directory the
 * bundler names: some packages are installed more than once, and a lookup by
 * name could read another copy. A licence file that is copyright lines over a licence body,
 * under at most one title line, is kept as the lines and the body, the body
 * once however many packages share it; any other file is kept whole, so a
 * second notice inside one file (Lucide's Feather list) stays where its file
 * has it. A package that ships no licence file takes its rows of the
 * caller's table: its upstream copyright lines and address, with the text of
 * a shipped package whose licence file upstream's is, or a file deeper in
 * the package.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** The fields of a package.json read here. */
export type Manifest = { name?: string; version?: string; license?: unknown; licenses?: unknown };

/** The licence a package.json declares: `license`, or the old `licenses` list joined by OR; "unknown" when it names none. */
export function licenseOf(manifest: Manifest): string {
  const field = manifest.license ?? manifest.licenses;
  if (typeof field === "string") return field;
  if (field && typeof field === "object" && "type" in field) {
    return String((field as { type: unknown }).type);
  }
  if (Array.isArray(field)) {
    return field
      .map((l) => (typeof l === "string" ? l : String((l as { type: unknown }).type)))
      .join(" OR ");
  }
  return "unknown";
}

/**
 * The directory of the package each source file of a bundle belongs to: the
 * path up to the name after the last `node_modules` segment, a scope and its
 * name as one, so a nested copy is its own package and a package's inner
 * package.json (an ESM marker) never passes for one. A source is a path from
 * the workspace root (`/node_modules/react/index.js`, as Expo names them) or
 * an absolute path under it. A bundler's virtual modules (`__prelude__`,
 * `\0polyfill:...`), a query (`/apps/mobile/app?ctx=...`) and our own files
 * are not a third party's.
 */
export function shippedPackageDirs(sources: Iterable<string>, root: string): string[] {
  const dirs = new Set<string>();
  for (const source of sources) {
    if (source.includes("\0")) continue;
    const file = source.replace(/\?.*$/s, "");
    const fromRoot = file.startsWith(`${root}/`) ? file.slice(root.length) : file;
    if (!fromRoot.startsWith("/")) continue;
    const segments = fromRoot.slice(1).split("/");
    const at = segments.lastIndexOf("node_modules");
    const end = at + (segments[at + 1]?.startsWith("@") ? 3 : 2);
    // Outside node_modules, or no file inside a package: nothing shipped from it.
    if (at < 0 || segments.length <= end) continue;
    dirs.add(join(root, ...segments.slice(0, end)));
  }
  return [...dirs].sort();
}

/**
 * A text without the newlines at either end. A scan, not a regex: /\n+$/
 * retries from every newline of a long run, which a file of untrusted
 * contents can make quadratic (CodeQL js/polynomial-redos).
 */
function trimNewlines(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === "\n") start += 1;
  while (end > start && text[end - 1] === "\n") end -= 1;
  return text.slice(start, end);
}

/** A text as its file has it, without a byte-order mark, Windows line ends, spaces at line ends or blank lines at either end. */
export function normaliseText(text: string): string {
  return trimNewlines(
    text
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n"),
  );
}

/** The paragraphs of a text, each the run of lines between blank ones (a line of spaces is blank), in order; line by line, so in time linear in the text. */
export function blocksOf(text: string): string[] {
  const blocks: string[] = [];
  let block: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() !== "") block.push(line);
    else if (block.length > 0) {
      blocks.push(block.join("\n"));
      block = [];
    }
  }
  if (block.length > 0) blocks.push(block.join("\n"));
  return blocks;
}

/** A licence or NOTICE file of a package: its name as the package ships it, and its text. */
export type ShippedFile = { file: string; text: string };

const LICENCE_FILE = /^(licen[cs]e|copying)/i;
const NOTICE_FILE = /^notice/i;
/** Code or data that happens to share the name (license-checker.json, licenses.js). */
const NOT_A_TEXT = /\.([cm]?[jt]sx?|json|map)$/i;

/** The licence files (LICENSE*, LICENCE*, COPYING*) and NOTICE files at the top of a package directory, in any case, each in name order; an empty one is none, and so is code or data of the same name. */
export function shippedFilesOf(dir: string): { licences: ShippedFile[]; notices: ShippedFile[] } {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const read = (pattern: RegExp): ShippedFile[] =>
    names
      .filter((file) => pattern.test(file) && !NOT_A_TEXT.test(file))
      .map((file) => ({ file, text: normaliseText(readFileSync(join(dir, file), "utf8")) }))
      .filter(({ text }) => text !== "");
  return { licences: read(LICENCE_FILE), notices: read(NOTICE_FILE) };
}

const TITLE = /^(the )?[\w.-]+( [\w.-]+)? licen[cs]e( \([\w.-]+\))?$/i;
const COPYRIGHT = /^(copyright\b|\(c\) |©)/i;
const RESERVED = /^all rights reserved\.?$/i;

/**
 * A licence file as its copyright lines and the body under them, when it is
 * that shape: at most one title line ("MIT License", "The ISC License (ISC)"),
 * one or more copyright lines (an "All rights reserved." under them is one
 * of them), then the body, blank lines anywhere between. The title is the
 * licence's name, which the package's licence field says too. Null for a
 * file of any other shape (Apache-2.0's whole text, a file that opens with
 * prose), which is kept whole.
 */
export function splitNotice(text: string): { copyright: string[]; body: string } | null {
  const lines = text.split("\n");
  const copyright: string[] = [];
  let titled = false;
  let at = lines.length;
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "") continue;
    if (COPYRIGHT.test(line) || (copyright.length > 0 && RESERVED.test(line))) {
      copyright.push(line);
    } else if (!titled && copyright.length === 0 && TITLE.test(line)) titled = true;
    else {
      at = index;
      break;
    }
  }
  const body = trimNewlines(lines.slice(at).join("\n"));
  return copyright.length > 0 && body !== "" ? { copyright, body } : null;
}

/**
 * The key of a text among the shared ones: a digest of its paragraphs' words,
 * so a body wrapped at another width is the same body, and one paragraphed
 * otherwise is not.
 */
export function textKey(text: string): string {
  const words = blocksOf(text)
    .map((paragraph) => paragraph.split(/\s+/).filter(Boolean).join(" "))
    .join("\n\n");
  return createHash("sha256").update(words).digest("hex").slice(0, 12);
}

/**
 * A licence of a package that ships no licence file at its top: either the
 * upstream copyright lines and the address they were read at, with the text
 * of a shipped package whose licence file is upstream's (`like`, by name);
 * or a file deeper in the package itself (a bundler's list of the code it
 * vendored), whole.
 */
export type Upstream = { copyright: string[]; like: string; from: string } | { file: string };

/** One licence of a package: the file it came from, or for an upstream row null and the address; its copyright lines; and the key of its text. */
export type Licence = { file: string | null; copyright: string[]; text: string; from?: string };

export type PackageNotices = {
  name: string;
  version: string;
  /** The package.json's licence field. */
  license: string;
  /** One or more. */
  licences: Licence[];
  /** The keys of its NOTICE files' texts. */
  notices: string[];
};

/** The packages, sorted by name and version, and every text they refer to by its key. */
export type Notices = { texts: Record<string, string>; packages: PackageNotices[] };

type Found = { name: string; version: string; license: string; dir: string };

function byNameAndVersion<T extends { name: string; version: string }>(a: T, b: T): number {
  return a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name);
}

/**
 * Every package of `dirs` once by name and version (the first directory of
 * a copy installed twice), with its licences and notices. A package with no
 * licence file takes its rows of `upstream`, by name. It throws for a package
 * with neither, so a new dependency cannot reach a build without its text;
 * for a row no package needs, so the table never outlives its reason; and
 * for a row whose text cannot be had: a `like` that does not ship, carries
 * more than one licence or another licence than the package's own (which a
 * relicensing would cause), or a file the package does not have.
 */
export function collectNotices(
  dirs: Iterable<string>,
  upstream: Readonly<Record<string, readonly Upstream[]>> = {},
): Notices {
  const found = new Map<string, Found>();
  for (const dir of [...dirs].sort()) {
    const manifest: Manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const name = manifest.name ?? basename(dir);
    const version = manifest.version ?? "?";
    const key = `${name}@${version}`;
    if (!found.has(key)) found.set(key, { name, version, license: licenseOf(manifest), dir });
  }

  const texts = new Map<string, string>();
  const keep = (text: string): string => {
    const key = textKey(text);
    if (!texts.has(key)) texts.set(key, text);
    return key;
  };
  const packages: PackageNotices[] = [];
  // A package with no licence file of its own, with the NOTICE files it ships all the same.
  const without: Array<Found & { notices: string[] }> = [];
  for (const pkg of [...found.values()].sort(byNameAndVersion)) {
    const { licences, notices } = shippedFilesOf(pkg.dir);
    if (licences.length === 0) {
      without.push({ ...pkg, notices: notices.map(({ text }) => keep(text)) });
      continue;
    }
    packages.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      licences: licences.map(({ file, text }) => {
        const split = splitNotice(text);
        return split
          ? { file, copyright: split.copyright, text: keep(split.body) }
          : { file, copyright: [], text: keep(text) };
      }),
      notices: notices.map(({ text }) => keep(text)),
    });
  }

  // A map, so a package named like an Object.prototype member is no row.
  const table = new Map(Object.entries(upstream));
  const owed = without.map((pkg) => ({ pkg, rows: table.get(pkg.name) ?? [] }));
  const unlisted = owed.filter(({ rows }) => rows.length === 0);
  if (unlisted.length > 0) {
    const names = unlisted.map(({ pkg }) => `${pkg.name}@${pkg.version}`).join(", ");
    throw new Error(
      `no licence text for ${names}: the package ships no licence file and the table of upstream licences has no row for it`,
    );
  }
  const unused = [...table.keys()].filter((name) => !without.some((pkg) => pkg.name === name));
  if (unused.length > 0) {
    throw new Error(
      `the table of upstream licences has a row nothing needs: ${unused.join(", ")} ships its own licence file now, or no longer ships`,
    );
  }
  const fromFiles = new Map(packages.map((p) => [p.name, p]));
  for (const { pkg, rows } of owed) {
    const at = `${pkg.name}@${pkg.version}`;
    const licences = rows.map((row): Licence => {
      if ("file" in row) {
        const path = join(pkg.dir, row.file);
        if (!existsSync(path)) throw new Error(`${at} has no ${row.file}, which its row names`);
        return {
          file: row.file,
          copyright: [],
          text: keep(normaliseText(readFileSync(path, "utf8"))),
        };
      }
      const like = fromFiles.get(row.like);
      const only =
        like?.licences.length === 1 && like.license === pkg.license ? like.licences[0] : undefined;
      if (!only) {
        let what = "this bundle does not carry";
        if (like?.license !== pkg.license && like) what = `is under ${like.license}`;
        else if (like) what = `carries ${like.licences.length} licence files`;
        else if (without.some((p) => p.name === row.like))
          what = "ships no licence file of its own";
        throw new Error(
          `${at} takes its ${pkg.license} text from ${row.like}, which ${what}: pick another package for its row`,
        );
      }
      return { file: null, copyright: row.copyright, text: only.text, from: row.from };
    });
    packages.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      licences,
      notices: pkg.notices,
    });
  }
  return {
    texts: Object.fromEntries([...texts].sort(([a], [b]) => a.localeCompare(b))),
    packages: packages.sort(byNameAndVersion),
  };
}
