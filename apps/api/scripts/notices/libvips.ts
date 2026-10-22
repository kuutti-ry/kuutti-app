/**
 * Gathers notices/libvips.json (#421): the libvips part of the API image's
 * THIRD_PARTY_NOTICES (#416), for one sharp-libvips release, as
 * notices/README.md describes the hand procedure of 22/10/2026.
 *
 * Everything it reads comes through a Source: sharp-libvips' build at the
 * release's tag, each library's licence files at the commit its version's
 * tag names, librsvg's Cargo files, the .crate files of static.crates.io,
 * the npm package and its shared library. scripts/notices-libvips.ts gives
 * it the network and a cache; the tests give it a table. Nothing read is
 * executed: build/posix.sh is read line by line for what it fetches and
 * edits, under conditions evaluated with the platform's environment; Cargo's
 * manifests and lock are parsed and their features resolved here; archives
 * are read in memory, never unpacked.
 *
 * What the code cannot know is the table LIBRARIES: for each library the
 * build makes, the licence it is used under, where its repository is and
 * which files carry its licence. A library the build gains, or a row it no
 * longer needs, fails the gathering, so a release that changes them is a
 * change of the table, reviewed like any other.
 */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { type Licence, normaliseText, splitNotice, textKey } from "@kuutti/notices";
import { parse as parseToml } from "smol-toml";
import type { LibvipsPart } from "./third-party.ts";

/** What the gathering reads: an address's text or bytes, and the commit a tag of a git repository names. */
export type Source = {
  text(url: string): Promise<string>;
  bytes(url: string): Promise<Uint8Array>;
  /** The commit of `ref`, a tag or an abbreviated commit, in the repository at `repository`. */
  commit(repository: string, ref: string): Promise<string>;
};

/** The image's platform: the npm package, sharp-libvips' name for it, and Rust's target. */
const PACKAGE = "@img/sharp-libvips-linux-arm64";
const PLATFORM = "linux-arm64v8";
const SHARP_LIBVIPS = "https://raw.githubusercontent.com/lovell/sharp-libvips";
const LGPL = "https://www.gnu.org/licenses/lgpl-3.0.txt";
const GPL = "https://www.gnu.org/licenses/gpl-3.0.txt";

/**
 * `rustc --print cfg --target aarch64-unknown-linux-gnu`, which decides
 * librsvg's target-specific crates. A cfg not here is false, as for Cargo.
 */
const TARGET = "aarch64-unknown-linux-gnu";
const TARGET_CFG: ReadonlySet<string> = new Set([
  "unix",
  'panic="unwind"',
  'target_arch="aarch64"',
  'target_endian="little"',
  'target_env="gnu"',
  'target_family="unix"',
  'target_feature="neon"',
  'target_has_atomic="8"',
  'target_has_atomic="16"',
  'target_has_atomic="32"',
  'target_has_atomic="64"',
  'target_has_atomic="128"',
  'target_has_atomic="ptr"',
  'target_os="linux"',
  'target_pointer_width="64"',
  'target_vendor="unknown"',
]);

// --- sharp-libvips' release -------------------------------------------------

/** versions.properties as versions.json names them: VERSION_ZLIB_NG=2.3.3 is zlib-ng. */
export function parseProperties(text: string): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (!line.startsWith("VERSION_") || at < 0) continue;
    versions[versionKey(line.slice("VERSION_".length, at))] = line.slice(at + 1).trim();
  }
  return versions;
}

function versionKey(variable: string): string {
  return variable.toLowerCase().replaceAll("_", "-");
}

/** The environment a platform's Dockerfile sets (its ENV lines), which build/posix.sh tests. */
export function dockerEnv(dockerfile: string): Record<string, string> {
  const env: Record<string, string> = {};
  const joined = dockerfile.replace(/\\\n/g, " ");
  for (const line of joined.split("\n")) {
    if (!line.startsWith("ENV ")) continue;
    for (const match of line.matchAll(/([A-Z_][A-Z0-9_]*)="([^"]*)"/g)) {
      env[match[1] as string] = match[2] as string;
    }
  }
  return env;
}

/** A sed edit of a Cargo manifest: on each line holding `address`, the first `from` becomes `to`. */
export type Edit = { address: string; from: string; to: string; files: string[] };

/** A library build/posix.sh builds for the platform: its directory, its key in versions.json, the release and patches it is made of, and its edits of Cargo manifests. */
export type Built = {
  dir: string;
  key: string;
  tarball: string;
  patches: string[];
  edits: Edit[];
};

const MKDIR = /^\s*mkdir \$\{DEPS\}\/([\w.-]+)\s*$/;
// The address may hold a space: $(without_patch $VERSION_GLIB).
const FETCH = /^\s*\$CURL (https:\/\/[^|]+) \| (tar|patch) /;
const SED = /^\s*sed -i'\.bak' "((?:[^"\\]|\\.)*)" (.+)$/;
const FUNCTION = /^(?:function ([A-Za-z_]\w*) \{|([A-Za-z_]\w*)\(\) \{)$/;

/**
 * The libraries build/posix.sh builds on this platform, in its order. The
 * script is read, not run: a function holding a library's build is read
 * where it is called, `if` blocks count only where their condition holds in
 * `env`, and a library's lines under a condition this cannot evaluate fail
 * it rather than guess.
 */
export function builtLibraries(
  script: string,
  versions: Record<string, string>,
  env: Record<string, string>,
): Built[] {
  const lines = script.split("\n");
  const functions = new Map<string, string[]>();
  const top: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const start = FUNCTION.exec(lines[i] as string);
    if (!start) {
      top.push(lines[i] as string);
      continue;
    }
    const body: string[] = [];
    for (i += 1; i < lines.length && lines[i] !== "}"; i += 1) body.push(lines[i] as string);
    functions.set((start[1] ?? start[2]) as string, body);
  }
  const relevant = (line: string) => MKDIR.test(line) || FETCH.test(line) || SED.test(line);
  const expanded = top.flatMap((line) => {
    const body = functions.get(line.trim().split(" ")[0] as string);
    return body?.some(relevant) ? body : [line];
  });

  const built: Built[] = [];
  const blocks: Array<{ holds: boolean | null; taken: boolean }> = [];
  let current: Built | undefined;
  for (const line of expanded) {
    const trimmed = line.trim();
    const opening = /^(if|elif) (.+); then$/.exec(trimmed);
    if (opening?.[1] === "if") {
      const holds = condition(opening[2] as string, env);
      blocks.push({ holds, taken: holds === true });
      continue;
    }
    const block = blocks.at(-1);
    if (opening && block) {
      const holds = block.taken ? false : condition(opening[2] as string, env);
      block.holds = holds;
      block.taken ||= holds === true;
      continue;
    }
    if (trimmed === "else" && block) {
      block.holds = block.holds === null ? null : !block.taken;
      block.taken = true;
      continue;
    }
    if (trimmed === "fi") {
      blocks.pop();
      continue;
    }
    if (!relevant(line)) continue;
    if (blocks.some((b) => b.holds === null)) {
      throw new Error(`build/posix.sh: a condition this cannot evaluate holds "${trimmed}"`);
    }
    if (blocks.some((b) => b.holds === false)) continue;
    const dir = MKDIR.exec(line)?.[1];
    if (dir) {
      current = built.find((b) => b.dir === dir);
      if (!current) {
        current = { dir, key: "", tarball: "", patches: [], edits: [] };
        built.push(current);
      }
      continue;
    }
    if (!current) throw new Error(`build/posix.sh: "${trimmed}" comes before any library`);
    const fetch = FETCH.exec(line);
    if (fetch) {
      const { url, keys } = expand(fetch[1] as string, versions);
      if (fetch[2] === "patch") {
        if (!current.patches.includes(url)) current.patches.push(url);
      } else if (current.tarball && current.tarball !== url) {
        throw new Error(`build/posix.sh fetches ${current.dir} from two releases`);
      } else {
        if (keys.length !== 1) {
          throw new Error(`build/posix.sh: ${url} names ${keys.length} versions, not one`);
        }
        current.tarball = url;
        current.key = keys[0] as string;
      }
      continue;
    }
    // What is left is a sed.
    const edit = cargoEdit(SED.exec(line) as RegExpExecArray);
    if (edit) current.edits.push(edit);
  }
  const unfetched = built.filter((b) => !b.tarball);
  if (unfetched.length > 0) {
    throw new Error(`build/posix.sh fetches no release of ${unfetched.map((b) => b.dir)}`);
  }
  return built;
}

/** The posix.sh helpers a release's address uses, as sharp-libvips 1.3.4 defines them: 2.90.0 is 2.90, 8.18.7-rc1 is 8.18.7. */
function withoutPatch(version: string): string {
  return version.replace(/\.[^.]*$/, "");
}
function withoutPrerelease(version: string): string {
  return version.replace(/-[^-]*$/, "");
}

const VARIABLE =
  /\$\(without_(patch|prerelease) \$VERSION_(\w+)\)|\$\{VERSION_(\w+)\/\/\.\/([-_])\}|\$\{VERSION_(\w+)\}|\$VERSION_(\w+)/g;

/** An address of posix.sh with its versions in, and the keys of the versions it names. */
function expand(url: string, versions: Record<string, string>): { url: string; keys: string[] } {
  const keys = new Set<string>();
  const value = (variable: string) => {
    const key = versionKey(variable);
    const version = versions[key];
    if (version === undefined)
      throw new Error(
        `build/posix.sh names VERSION_${variable}, which versions.properties does not`,
      );
    keys.add(key);
    return version;
  };
  const expanded = url.replace(VARIABLE, (_, helper, h, replaced, by, braced, bare) => {
    if (helper === "patch") return withoutPatch(value(h));
    if (helper === "prerelease") return withoutPrerelease(value(h));
    if (replaced) return value(replaced).replaceAll(".", by);
    return value(braced ?? bare);
  });
  if (expanded.includes("$"))
    throw new Error(`build/posix.sh: ${url} uses a variable this cannot expand`);
  return { url: expanded, keys: [...keys] };
}

/**
 * Whether `if <text>; then` holds: `[ ... ]` tests joined by || or &&, each
 * a string comparison or -z/-n; null when it is any other shape.
 */
export function condition(text: string, env: Record<string, string>): boolean | null {
  const any = text.split(" || ").map((part) => {
    const all = part.split(" && ").map((test) => single(test.trim(), env));
    return all.includes(null) ? null : all.every(Boolean);
  });
  if (any.includes(true)) return true;
  return any.includes(null) ? null : false;
}

function single(test: string, env: Record<string, string>): boolean | null {
  if (!test.startsWith("[ ") || !test.endsWith(" ]")) return null;
  const words = test.slice(2, -2).split(" ");
  if (words.length === 2 && (words[0] === "-z" || words[0] === "-n")) {
    const value = word(words[1] as string, env);
    if (value === null) return null;
    return words[0] === "-z" ? value === "" : value !== "";
  }
  if (words.length === 3 && (words[1] === "=" || words[1] === "==")) {
    const left = word(words[0] as string, env);
    const right = word(words[2] as string, env);
    return left === null || right === null ? null : left === right;
  }
  return null;
}

/** A word of a test: "$NAME", "${NAME}", "${NAME%-*}" (up to its last dash), or a literal. */
function word(raw: string, env: Record<string, string>): string | null {
  const text = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  const variable = /^\$(?:\{(\w+)(%-\*)?\}|(\w+))$/.exec(text);
  if (variable) {
    const value = env[(variable[1] ?? variable[3]) as string] ?? "";
    if (!variable[2]) return value;
    const dash = value.lastIndexOf("-");
    return dash < 0 ? value : value.slice(0, dash);
  }
  return text.includes("$") ? null : text;
}

/** A posix.sh sed's edit when it edits a Cargo manifest; those change which crates librsvg compiles in. */
function cargoEdit(sed: RegExpExecArray): Edit | null {
  const files = (sed[2] as string).split(" ").flatMap(braces);
  if (!files.some((file) => file.endsWith("Cargo.toml") || file.endsWith("Cargo.lock"))) {
    return null;
  }
  const expression = (sed[1] as string).replace(/\\(["\\$])/g, "$1");
  const parts = /^\/([^/]*)\/s\/([^/]*)\/([^/]*)\/$/.exec(expression);
  if (!parts || /[.*[\]^$\\]/.test(`${parts[1]}${parts[2]}`)) {
    throw new Error(
      `build/posix.sh edits ${files.join(" ")} with "${expression}", which this cannot apply`,
    );
  }
  return { address: parts[1] as string, from: parts[2] as string, to: parts[3] as string, files };
}

function braces(word: string): string[] {
  const open = word.indexOf("{");
  const close = word.indexOf("}", open);
  if (open < 0 || close < 0) return [word];
  return word
    .slice(open + 1, close)
    .split(",")
    .map((choice) => `${word.slice(0, open)}${choice}${word.slice(close + 1)}`);
}

/** Applies posix.sh's edits of a file to its text, as sed would. */
export function applyEdits(file: string, text: string, edits: readonly Edit[]): string {
  const mine = edits.filter((edit) => edit.files.includes(file));
  return text
    .split("\n")
    .map((line) =>
      mine.reduce(
        (edited, edit) =>
          edited.includes(edit.address) ? edited.replace(edit.from, edit.to) : edited,
        line,
      ),
    )
    .join("\n");
}

/** THIRD-PARTY-NOTICES.md's table: each library sharp-libvips names, and what it is used under there. */
export function usedUnder(markdown: string): Map<string, string> {
  const table = new Map<string, string>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const [name, used] = cells;
    if (!name || !used || name === "Library" || /^-+$/.test(name)) continue;
    table.set(name, used.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
  }
  return table;
}

// --- each library's own licence files ----------------------------------------

type Repo =
  | { kind: "github"; path: string }
  | { kind: "gitlab"; host: string; path: string }
  | { kind: "gitiles"; url: string };

const github = (path: string): Repo => ({ kind: "github", path });
const freedesktop = (path: string): Repo => ({
  kind: "gitlab",
  host: "gitlab.freedesktop.org",
  path,
});

function gitUrl(repo: Repo): string {
  if (repo.kind === "github") return `https://github.com/${repo.path}`;
  if (repo.kind === "gitlab") return `https://${repo.host}/${repo.path}.git`;
  return repo.url;
}

/** Where a file of a commit is read, and the address the notices name for it. */
function fileAt(repo: Repo, commit: string, file: string): { fetch: string; page: string } {
  if (repo.kind === "gitiles") {
    // gitiles serves a file's bytes only base64-encoded, under ?format=TEXT.
    const page = `${repo.url}/+/${commit}/${file}`;
    return { fetch: `${page}?format=TEXT`, page };
  }
  const page =
    repo.kind === "github"
      ? `https://raw.githubusercontent.com/${repo.path}/${commit}/${file}`
      : `https://${repo.host}/${repo.path}/-/raw/${commit}/${file}`;
  return { fetch: page, page };
}

/** A credit statement a licence asks a binary's documentation to make, kept as a copyright line of `file`. */
type Credit = { file: string; line: (read: (file: string) => Promise<string>) => Promise<string> };

/** A library of the build: how the notices name it, what it is used under, and where its licence files are. */
export type Row = {
  name: string;
  /** Its name in sharp-libvips' THIRD-PARTY-NOTICES.md, where that is another. */
  row?: string;
  license: string;
  /** Under the GNU Lesser General Public License, used under its version 3. */
  lgpl?: true;
  repo?: Repo;
  /** The tag (or commit) of a version. */
  ref?: (version: string) => string;
  files?: string[];
  /** Files kept whole: splitNotice would take their title for a copyright line. */
  whole?: string[];
  credit?: Credit;
  /** Libraries kept inside its source, built with it: their version and release are its own. */
  vendored?: Row[];
};

const lgpl = (name: string, license: string, more: Partial<Row> = {}): Row => ({
  name,
  license: `${license}, used under LGPL-3.0`,
  lgpl: true,
  ...more,
});
const v = (version: string) => `v${version}`;
const same = (version: string) => version;

/** Text between two phrases, both included, with its whitespace collapsed. */
function sentence(text: string, start: string, end: string, what: string): string {
  const flat = text.replace(/\s+/g, " ");
  const at = flat.indexOf(start);
  const to = flat.indexOf(end, at);
  if (at < 0 || to < 0) throw new Error(`${what} no longer says "${start} … ${end}"`);
  return flat.slice(at, to + end.length);
}

/**
 * The libraries build/posix.sh builds, by their key in versions.json, as
 * read on 22/10/2026 at each one's version: the licence it is used under
 * (sharp-libvips' table for the LGPL ones, the library's own files for the
 * rest), its repository, its tag, and its licence and copyright files.
 */
export const LIBRARIES: Readonly<Record<string, Row>> = {
  vips: lgpl("libvips", "LGPL-2.1-or-later", {
    repo: github("libvips/libvips"),
    ref: v,
    vendored: [
      {
        name: "libnsgif (in libvips)",
        row: "libnsgif",
        license: "MIT",
        files: ["libvips/foreign/libnsgif/COPYING"],
      },
    ],
  }),
  aom: {
    name: "aom",
    license: "BSD-2-Clause, with the Alliance for Open Media Patent License 1.0",
    repo: { kind: "gitiles", url: "https://aomedia.googlesource.com/aom" },
    ref: v,
    files: ["LICENSE", "PATENTS"],
  },
  cairo: {
    name: "cairo",
    license: "LGPL-2.1 OR MPL-1.1, used under MPL-1.1",
    repo: freedesktop("cairo/cairo"),
    ref: same,
    files: ["COPYING", "COPYING-MPL-1.1"],
  },
  cgif: { name: "cgif", license: "MIT", repo: github("dloebl/cgif"), ref: v, files: ["LICENSE"] },
  expat: {
    name: "expat",
    license: "MIT",
    repo: github("libexpat/libexpat"),
    ref: (version) => `R_${version.replaceAll(".", "_")}`,
    files: ["expat/COPYING"],
  },
  fontconfig: {
    name: "fontconfig",
    license: "HPND-style (fontconfig's own)",
    repo: freedesktop("fontconfig/fontconfig"),
    ref: same,
    files: ["COPYING"],
  },
  freetype: {
    name: "freetype",
    license: "FTL OR GPL-2.0-or-later, used under the FTL",
    repo: github("freetype/freetype"),
    ref: (version) => `VER-${version.replaceAll(".", "-")}`,
    files: ["LICENSE.TXT", "docs/FTL.TXT"],
    // FTL 1: "Portions of this software are copyright © <year> The FreeType
    // Project", the year that of the release, as its README's last copyright year.
    credit: {
      file: "docs/FTL.TXT",
      line: async (read) => {
        const ftl = sentence(
          await read("docs/FTL.TXT"),
          "Portions of this software",
          "All rights reserved.",
          "docs/FTL.TXT",
        );
        const year = /Copyright \(C\) \d{4}-(\d{4}) by/.exec(await read("README"))?.[1];
        if (!year || !ftl.includes("<year>"))
          throw new Error("freetype's README gives no year for the FTL's credit");
        return ftl.replace("<year>", year);
      },
    },
  },
  fribidi: lgpl("fribidi", "LGPL-2.1-or-later"),
  glib: lgpl("glib", "LGPL-2.1-or-later"),
  harfbuzz: {
    name: "harfbuzz",
    license: "MIT (Old MIT)",
    repo: github("harfbuzz/harfbuzz"),
    ref: same,
    files: ["COPYING"],
  },
  highway: {
    name: "highway",
    license: "Apache-2.0 OR BSD-3-Clause",
    repo: github("google/highway"),
    ref: same,
    files: ["LICENSE"],
  },
  lcms: {
    name: "lcms2",
    row: "lcms",
    license: "MIT",
    repo: github("mm2/Little-CMS"),
    ref: (version) => `lcms${version}`,
    files: ["LICENSE"],
  },
  archive: {
    name: "libarchive",
    license: "BSD-2-Clause",
    repo: github("libarchive/libarchive"),
    ref: v,
    files: ["COPYING"],
  },
  exif: lgpl("libexif", "LGPL-2.1-or-later"),
  ffi: {
    name: "libffi",
    license: "MIT",
    repo: github("libffi/libffi"),
    ref: v,
    files: ["LICENSE"],
  },
  heif: lgpl("libheif", "LGPL-3.0-or-later"),
  imagequant: {
    name: "libimagequant",
    license: "BSD-2-Clause",
    repo: github("lovell/libimagequant"),
    ref: v,
    files: ["COPYRIGHT"],
  },
  png: {
    name: "libpng",
    license: "libpng-2.0",
    repo: github("pnggroup/libpng"),
    ref: v,
    files: ["LICENSE"],
    // "COPYRIGHT NOTICE, DISCLAIMER, and LICENSE" heads the file; the copyright lines are inside.
    whole: ["LICENSE"],
  },
  // Its Rust crates are their own rows (librsvgCrates); the repository is for its Cargo files.
  rsvg: lgpl("librsvg", "LGPL-2.1-or-later", { repo: github("GNOME/librsvg"), ref: same }),
  tiff: {
    name: "libtiff",
    license: "libtiff",
    repo: { kind: "gitlab", host: "gitlab.com", path: "libtiff/libtiff" },
    ref: v,
    files: ["LICENSE.md"],
  },
  uhdr: {
    name: "libultrahdr",
    license: "MIT AND Apache-2.0, with BSD-3-Clause (modp_b64) and Adobe's gain map notice",
    repo: github("google/libultrahdr"),
    ref: v,
    files: [
      "LICENSE",
      "third_party/image_io/LICENSE",
      "third_party/image_io/src/modp_b64/LICENSE",
      "adobe-hdr-gain-map-license/NOTICE",
    ],
  },
  webp: {
    name: "libwebp",
    license: "BSD-3-Clause, with WebM's patent grant",
    repo: github("webmproject/libwebp"),
    ref: v,
    files: ["COPYING", "PATENTS"],
  },
  xml2: {
    name: "libxml2",
    license: "MIT",
    repo: github("GNOME/libxml2"),
    ref: v,
    files: ["Copyright"],
  },
  // Its version is a commit.
  mozjpeg: {
    name: "mozjpeg",
    license: "IJG AND BSD-3-Clause AND Zlib",
    repo: github("mozilla/mozjpeg"),
    ref: same,
    files: ["LICENSE.md", "README.ijg"],
    // The IJG licence's (2): "This software is based in part on the work of the Independent JPEG Group."
    credit: {
      file: "LICENSE.md",
      line: async (read) =>
        sentence(
          await read("LICENSE.md"),
          "This software is based in part",
          "Group.",
          "mozjpeg's LICENSE.md",
        ),
    },
  },
  pango: lgpl("pango", "LGPL-2.0-or-later"),
  pixman: {
    name: "pixman",
    license: "MIT",
    repo: freedesktop("pixman/pixman"),
    ref: (version) => `pixman-${version}`,
    files: ["COPYING"],
  },
  "zlib-ng": {
    name: "zlib-ng",
    license: "Zlib",
    repo: github("zlib-ng/zlib-ng"),
    ref: same,
    files: ["LICENSE.md"],
  },
};

type Library = LibvipsPart["libraries"][number];

/**
 * The texts of the part by their keys. Files that share a key differ in
 * their wrapping at most; the part keeps the copy of the first library that
 * names it, in the part's order (`copyOf`), as the hand gathering did.
 */
class Texts {
  private readonly first = new Map<string, string>();
  private readonly copies = new WeakMap<Licence, string>();
  /** The first copy read of a key's text. */
  text(key: string): string {
    return this.first.get(key) as string;
  }
  copyOf(licence: Licence): string {
    return this.copies.get(licence) as string;
  }
  /** A licence file as its copyright lines and body, or whole when it is not that shape or `whole` says so. */
  licence(from: string, text: string, credit?: string, whole = false): Licence {
    const split = whole ? null : splitNotice(text);
    const copyright = split ? split.copyright : [];
    const body = split ? split.body : text;
    const key = textKey(body);
    if (!this.first.has(key)) this.first.set(key, body);
    return this.of(from, key, credit ? [...copyright, credit] : copyright, body);
  }
  /** A licence whose text is one already read, by its key. */
  of(from: string, key: string, copyright: string[] = [], copy = this.text(key)): Licence {
    const licence = { file: null, from, copyright, text: key };
    this.copies.set(licence, copy);
    return licence;
  }
}

/** A row's licences: LGPL-3.0's text, or its files at the commit of its version, with its credit. */
async function rowLicences(
  row: Row,
  host: Row,
  version: string,
  source: Source,
  texts: Texts,
  lgplText: string,
): Promise<Licence[]> {
  if (row.lgpl) return [texts.licence(LGPL, lgplText, undefined, true)];
  const repo = host.repo;
  const ref = host.ref;
  if (!repo || !ref || !row.files)
    throw new Error(`${row.name}'s row names no repository and files`);
  const commit = await source.commit(gitUrl(repo), ref(version));
  const read = async (file: string) => {
    const { fetch } = fileAt(repo, commit, file);
    const raw = await source.text(fetch);
    return normaliseText(
      repo.kind === "gitiles" ? Buffer.from(raw.trim(), "base64").toString("utf8") : raw,
    );
  };
  const credit = row.credit ? await row.credit.line(read) : undefined;
  const licences: Licence[] = [];
  for (const file of row.files) {
    const text = await read(file);
    if (text === "") throw new Error(`${row.name}'s ${file} is empty at ${commit}`);
    const at = fileAt(repo, commit, file).page;
    const whole = row.whole?.includes(file);
    licences.push(texts.licence(at, text, row.credit?.file === file ? credit : undefined, whole));
  }
  return licences;
}

// --- archives ----------------------------------------------------------------

const decoder = new TextDecoder();

/** The regular files of a tar archive by path, read in memory: nothing of it is written or run. */
export function untar(archive: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let at = 0;
  let long: string | undefined;
  while (at + 512 <= archive.length) {
    const header = archive.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) => {
      const bytes = header.subarray(start, start + length);
      const end = bytes.indexOf(0);
      return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
    };
    const size = Number.parseInt(field(124, 12).trim(), 8);
    const type = field(156, 1);
    const body = archive.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") long = decoder.decode(body).split("\0")[0];
    else if (type === "x") long = paxPath(decoder.decode(body)) ?? long;
    else if (type === "0" || type === "") {
      const prefix = field(345, 155);
      const name = long ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
      files.set(name, body);
      long = undefined;
    } else long = undefined;
  }
  return files;
}

/** The path record of a pax header ("<length> path=<path>\n" among others). */
function paxPath(records: string): string | undefined {
  for (const record of records.split("\n")) {
    const at = record.indexOf(" path=");
    if (at > 0) return record.slice(at + " path=".length);
  }
  return undefined;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// --- Rust ----------------------------------------------------------------------

/** One entry of Cargo.lock. */
export type Locked = {
  name: string;
  version: string;
  source?: string;
  checksum?: string;
  dependencies: Array<{ name: string; version?: string }>;
};

export function parseLock(text: string): Locked[] {
  const lock = parseToml(text) as { package?: Array<Record<string, unknown>> };
  return (lock.package ?? []).map((p) => ({
    name: String(p.name),
    version: String(p.version),
    ...(typeof p.source === "string" ? { source: p.source } : {}),
    ...(typeof p.checksum === "string" ? { checksum: p.checksum } : {}),
    dependencies: ((p.dependencies as string[] | undefined) ?? []).map((entry) => {
      const [name, version] = entry.split(" ");
      return version ? { name: name as string, version } : { name: name as string };
    }),
  }));
}

/** A normal dependency of a manifest, for every target or for those `target` names. */
type Dependency = {
  key: string;
  name: string;
  req: string;
  optional: boolean;
  defaultFeatures: boolean;
  features: string[];
  target?: string;
};

/** What the resolution reads of a Cargo.toml. */
export type Manifest = {
  name: string;
  version: string;
  license?: string;
  procMacro: boolean;
  dependencies: Dependency[];
  features: Record<string, string[]>;
};

type Table = Record<string, unknown>;

/**
 * A Cargo.toml's normal dependencies, features and licence. Build and dev
 * dependencies are left out: they are not compiled into the library. A
 * workspace member's `workspace = true` takes the workspace's entry, its
 * own features added and optional its own.
 */
export function parseManifest(text: string, workspace?: Table): Manifest {
  const toml = parseToml(text) as Table;
  const pkg = toml.package as Table;
  const shared = ((workspace?.workspace as Table | undefined)?.package ?? {}) as Table;
  const inherited = (field: string) => {
    const value = pkg[field];
    return value && typeof value === "object" && (value as Table).workspace ? shared[field] : value;
  };
  const deps = ((workspace?.workspace as Table | undefined)?.dependencies ?? {}) as Table;
  const dependencies: Dependency[] = [];
  const read = (table: unknown, target?: string) => {
    for (const [key, raw] of Object.entries((table ?? {}) as Table)) {
      let entry: Table = typeof raw === "string" ? { version: raw } : (raw as Table);
      if (entry.workspace) {
        const base = deps[key];
        const from: Table = typeof base === "string" ? { version: base } : ((base ?? {}) as Table);
        entry = {
          ...from,
          ...(entry.optional ? { optional: true } : {}),
          features: [
            ...((from.features as string[]) ?? []),
            ...((entry.features as string[]) ?? []),
          ],
        };
      }
      dependencies.push({
        key,
        name: typeof entry.package === "string" ? entry.package : key,
        req: typeof entry.version === "string" ? entry.version : "*",
        optional: entry.optional === true,
        defaultFeatures: entry["default-features"] !== false,
        features: (entry.features as string[] | undefined) ?? [],
        ...(target ? { target } : {}),
      });
    }
  };
  read(toml.dependencies);
  for (const [target, tables] of Object.entries((toml.target ?? {}) as Table)) {
    read((tables as Table).dependencies, target);
  }
  const license = inherited("license");
  return {
    name: String(pkg.name),
    version: String(inherited("version")),
    ...(typeof license === "string" ? { license } : {}),
    procMacro: (toml.lib as Table | undefined)?.["proc-macro"] === true,
    dependencies,
    features: (toml.features ?? {}) as Record<string, string[]>,
  };
}

/** Whether a target table's key (`cfg(...)` or a triple) is this platform's. */
export function targetHolds(target: string): boolean {
  if (!target.startsWith("cfg(")) return target === TARGET;
  const tokens = target.match(/[A-Za-z_][\w]*|"[^"]*"|[(),=]/g) as string[];
  // After "cfg" and "(".
  let at = 2;
  const next = () => tokens[at++];
  const predicate = (): boolean => {
    const name = next();
    if (name === "all" || name === "any" || name === "not") {
      if (next() !== "(") throw new Error(`a cfg this cannot read: ${target}`);
      const values: boolean[] = [];
      while (tokens[at] !== ")") {
        values.push(predicate());
        if (tokens[at] === ",") at += 1;
      }
      at += 1;
      if (name === "not") return !values[0];
      return name === "all" ? values.every(Boolean) : values.some(Boolean);
    }
    if (tokens[at] === "=") {
      at += 1;
      return TARGET_CFG.has(`${name}=${next()}`);
    }
    return TARGET_CFG.has(String(name));
  };
  return predicate();
}

/** Whether `version` meets a plain, caret or tilde requirement: what tells two locked versions of one crate apart. */
function meets(req: string, version: string): boolean {
  const first = (req.split(",")[0] as string).trim();
  if (/^[<>]/.test(first)) throw new Error(`a requirement this cannot match: ${req}`);
  const tilde = first.startsWith("~");
  const wanted = first
    .replace(/^[\^~=]\s*/, "")
    .split(".")
    .map(Number);
  const have = version.split(/[.+-]/).map(Number);
  const significant = tilde ? 2 : Math.max(1, wanted.findIndex((n) => n !== 0) + 1);
  for (let i = 0; i < significant && i < wanted.length; i += 1) {
    if (have[i] !== wanted[i]) return false;
  }
  return true;
}

/** A crate of the resolution: its lock entry, its manifest and its .crate's files. */
export type Crate = { locked: Locked; manifest: Manifest; files: Map<string, Uint8Array> | null };

/**
 * The crates a build of `root` with `features` compiles for this platform,
 * as Cargo's feature resolver (2 and 3) would: the lock fixes each crate's
 * version, the manifests which dependencies and features are on; optional
 * dependencies through features (dep:x, x/f, the weak x?/f, and the
 * implicit feature of an optional dependency nothing names with dep:),
 * target tables by the cfg of TARGET, default features unless turned off.
 * A proc-macro crate and anything only a build script needs run on the
 * build machine and are not in the library, so neither is followed.
 * `load` reads a crate's manifest and files, a workspace member's too.
 */
export async function resolveCrates(
  lock: readonly Locked[],
  root: { name: string; features: string[] },
  load: (locked: Locked) => Promise<Crate>,
): Promise<Crate[]> {
  const byId = (locked: Locked) => `${locked.name} ${locked.version}`;
  const find = (name: string, version?: string) => {
    const found = lock.filter((p) => p.name === name && (!version || p.version === version));
    if (found.length !== 1)
      throw new Error(`Cargo.lock has ${found.length} ${name} ${version ?? ""}`);
    return found[0] as Locked;
  };
  type State = { crate: Crate; features: Set<string> };
  const states = new Map<string, State>();
  const crates = new Map<string, Promise<Crate>>();
  const crateOf = (locked: Locked) => {
    const id = byId(locked);
    if (!crates.has(id)) crates.set(id, load(locked));
    return crates.get(id) as Promise<Crate>;
  };
  const queue: string[] = [];
  const request = async (locked: Locked, features: Iterable<string>) => {
    const id = byId(locked);
    const known = states.get(id);
    const state = known ?? { crate: await crateOf(locked), features: new Set<string>() };
    states.set(id, state);
    const before = state.features.size;
    for (const feature of features) state.features.add(feature);
    if (!known || state.features.size > before) queue.push(id);
  };
  await request(find(root.name), [...root.features, "default"]);
  while (queue.length > 0) {
    const state = states.get(queue.shift() as string) as State;
    const { manifest, locked } = state.crate;
    const named = new Set(
      Object.values(manifest.features)
        .flat()
        .filter((value) => value.startsWith("dep:"))
        .map((value) => value.slice(4)),
    );
    const on = new Set<string>();
    const strong = new Map<string, Set<string>>();
    const weak = new Map<string, Set<string>>();
    const add = (map: Map<string, Set<string>>, key: string, feature: string) => {
      map.set(key, (map.get(key) ?? new Set()).add(feature));
    };
    const enabled = new Set<string>();
    const pending = [...state.features];
    while (pending.length > 0) {
      const feature = pending.pop() as string;
      if (enabled.has(feature)) continue;
      enabled.add(feature);
      const optional = manifest.dependencies.some((d) => d.optional && d.key === feature);
      const values =
        manifest.features[feature] ?? (optional && !named.has(feature) ? [`dep:${feature}`] : []);
      for (const value of values) {
        const slash = value.indexOf("/");
        if (value.startsWith("dep:")) on.add(value.slice(4));
        else if (slash < 0) pending.push(value);
        else if (value[slash - 1] === "?")
          add(weak, value.slice(0, slash - 1), value.slice(slash + 1));
        else {
          const key = value.slice(0, slash);
          add(strong, key, value.slice(slash + 1));
          if (manifest.dependencies.some((d) => d.optional && d.key === key)) on.add(key);
          // `x/f` with x a feature of this crate, not a dependency, does not occur in Cargo.
        }
      }
    }
    for (const dep of manifest.dependencies) {
      if (dep.optional && !on.has(dep.key)) continue;
      if (dep.target && !targetHolds(dep.target)) continue;
      const entries = locked.dependencies.filter((d) => d.name === dep.name);
      const candidates =
        entries.length > 1 ? entries.filter((d) => meets(dep.req, d.version as string)) : entries;
      if (candidates.length !== 1) {
        throw new Error(
          `${byId(locked)} needs ${dep.name} ${dep.req}, which Cargo.lock gives it ${candidates.length} times`,
        );
      }
      const target = find(dep.name, candidates[0]?.version);
      if ((await crateOf(target)).manifest.procMacro) continue;
      const features = [
        ...dep.features,
        ...(strong.get(dep.key) ?? []),
        ...(weak.get(dep.key) ?? []),
      ];
      await request(target, dep.defaultFeatures ? [...features, "default"] : features);
    }
  }
  return [...states.values()].map((s) => s.crate);
}

/** What Rust left in the shared library: the standard library's commit and version, and the crates it was built with. */
export function rustOf(binary: Uint8Array): {
  commit: string;
  version: string;
  crates: Array<{ name: string; version: string }>;
} {
  const buffer = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength);
  const printable = (from: number) => {
    let end = from;
    while (end < buffer.length && (buffer[end] as number) >= 0x20 && (buffer[end] as number) < 0x7f)
      end += 1;
    return buffer.toString("latin1", from, end);
  };
  const all = (needle: string) => {
    const found: string[] = [];
    for (let at = buffer.indexOf(needle); at >= 0; at = buffer.indexOf(needle, at + 1)) {
      found.push(printable(at));
    }
    return found;
  };
  const rustc = /^rustc version (\S+) \(([0-9a-f]+) (\d{4}-\d{2}-\d{2})\)/.exec(
    all("rustc version ")[0] ?? "",
  );
  const commits = new Set(all("/rustc/").map((path) => path.split("/")[2] as string));
  const commit = [...commits][0];
  if (!rustc || commits.size !== 1 || !commit || !commit.startsWith(rustc[2] as string)) {
    throw new Error("the shared library names no one Rust standard library");
  }
  const crates = new Map<string, { name: string; version: string }>();
  for (const path of all("/cargo/registry/")) {
    const dir = path.split("/")[4] ?? "";
    // name-1.2.3: the version is what follows the last dash before a digit.
    let dash = dir.lastIndexOf("-");
    while (dash > 0 && !/\d/.test(dir[dash + 1] ?? "")) dash = dir.lastIndexOf("-", dash - 1);
    if (dash > 0) crates.set(dir, { name: dir.slice(0, dash), version: dir.slice(dash + 1) });
  }
  return {
    commit,
    version: `${rustc[1]} ${rustc[3]}`,
    crates: [...crates.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const LICENCE_NAME = /^(licen[cs]e|copying|copyright|unlicense|notice)/i;
const CODE = /\.([cm]?[jt]sx?|json|map|rs|toml)$/i;

/**
 * How each licence a crate can be under reads, to tell a licence's text
 * from a file that only names it (siphasher's COPYING) and to know which
 * file is an alternative the notices do not use.
 */
const READS: Readonly<Record<string, readonly string[]>> = {
  // Unicode's licence grants the same words for "a copy of data files".
  MIT: [
    "Permission is hereby granted, free of charge, to any person obtaining a copy of this software",
  ],
  "Apache-2.0": ["Apache License", "Version 2.0, January 2004"],
  "BSD-3-Clause": ["Redistribution and use in source and binary forms", "Neither the name"],
  "MPL-2.0": ["Mozilla Public License Version 2.0"],
  "Unicode-3.0": ["UNICODE LICENSE V3"],
  Zlib: ["This software is provided 'as-is'", "Altered source versions must be plainly marked"],
  Unlicense: ["This is free and unencumbered software released into the public domain"],
};

/** The licence whose text a file holds, if any, by phrases its text has (whitespace aside). */
function reads(text: string): string | undefined {
  const flat = text.replace(/\s+/g, " ");
  return Object.keys(READS).find((id) => READS[id]?.every((phrase) => flat.includes(phrase)));
}

/**
 * The licences a crate is used under: of an SPDX expression's alternatives,
 * the one with MIT, else the one with BSD-3-Clause (sharp-libvips' choice
 * for highway), as the AND of its licences. An expression without a choice
 * is used as it is.
 */
export function usedLicences(expression: string): {
  ids: string[];
  all: string[];
  chosen: boolean;
} {
  const tokens = expression.replaceAll("/", " OR ").match(/\(|\)|[^\s()]+/g) as string[];
  let at = 0;
  // SPDX: AND binds closer than OR. Each alternative is a list of licences that all apply.
  const or = (): string[][] => {
    let alternatives = and();
    while (tokens[at] === "OR") {
      at += 1;
      alternatives = [...alternatives, ...and()];
    }
    return alternatives;
  };
  const and = (): string[][] => {
    let alternatives = term();
    while (tokens[at] === "AND") {
      at += 1;
      const right = term();
      alternatives = alternatives.flatMap((left) => right.map((r) => [...left, ...r]));
    }
    return alternatives;
  };
  const term = (): string[][] => {
    const token = tokens[at++];
    if (token !== "(") return [[String(token)]];
    const inner = or();
    at += 1;
    return inner;
  };
  const alternatives = or();
  const all = [...new Set(alternatives.flat())];
  const pick =
    alternatives.find((a) => a.includes("MIT")) ??
    alternatives.find((a) => a.includes("BSD-3-Clause")) ??
    (alternatives.length === 1 ? alternatives[0] : undefined);
  if (!pick) throw new Error(`no choice made for "${expression}": add one to usedLicences`);
  return { ids: pick, all, chosen: alternatives.length > 1 };
}

/** The licence a file's name says it holds (LICENSE-APACHE, UNLICENSE), among a crate's. */
function namedBy(file: string, ids: readonly string[]): string | undefined {
  const base = file.replace(/\.(md|txt)$/i, "").toUpperCase();
  const said = base === "UNLICENSE" ? "UNLICENSE" : /^LICEN[CS]E-(.+)$/.exec(base)?.[1];
  const plain = (id: string) => id.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return said ? ids.find((id) => plain(id).startsWith(plain(said))) : undefined;
}

type Gathered = { library: Library; owed: Array<{ id: string; from: string }> };

/**
 * A crate as a library of the part: its licence, and the licence files of
 * its .crate that the licences it is used under need. A file that holds an
 * alternative it is not used under, by name or by text, is left out, and so
 * is one that only says which licences apply without a copyright word. A
 * licence it is used under whose text no file holds is owed: the text most
 * crates under it carry fills it in (`owed`).
 */
function crateLibrary(crate: Crate, label: string, texts: Texts): Gathered {
  const { name, version, license } = crate.manifest;
  if (!license) throw new Error(`${name} ${version} names no licence in its Cargo.toml`);
  const url = `https://static.crates.io/crates/${name}/${name}-${version}.crate`;
  const { ids, all, chosen } = usedLicences(license);
  const top = `${name}-${version}/`;
  // The file named for a licence it is used under first, then the other licence files, then the rest.
  const rank = (file: string) => {
    const named = namedBy(file, all);
    if (named && ids.includes(named)) return 0;
    return /^licen[cs]e/i.test(file) ? 1 : 2;
  };
  const files = [...(crate.files as Map<string, Uint8Array>).entries()]
    .filter(([path]) => path.startsWith(top) && !path.slice(top.length).includes("/"))
    .map(([path, bytes]) => ({
      file: path.slice(top.length),
      text: normaliseText(decoder.decode(bytes)),
    }))
    .filter(({ file, text }) => LICENCE_NAME.test(file) && !CODE.test(file) && text !== "")
    .sort((a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file));
  const kept = files.filter(({ file, text }) => {
    const holds = reads(text) ?? namedBy(file, all);
    if (holds) return ids.includes(holds) || !all.includes(holds);
    return /copyright/i.test(text);
  });
  const licences = kept.map(({ file, text }) => texts.licence(`${url} (${file})`, text));
  const held = new Set(kept.map(({ text }) => reads(text)));
  const owed = ids
    .filter((id) => !held.has(id))
    .map((id) => ({
      id,
      from:
        kept.length > 0
          ? `${url} (the ${id} licence its ${kept.map((f) => f.file).join(" and ")} names, which the crate does not carry)`
          : url,
    }));
  return {
    library: {
      name: `${name} (${label})`,
      version,
      // The old "MIT/Apache-2.0" in SPDX's words.
      license: chosen
        ? `${license.replaceAll("/", " OR ")}, used under ${ids.join(" AND ")}`
        : license,
      source: [url],
      licences,
    },
    owed,
  };
}

/** For each licence, the text most of the crates under it carry (the smallest key of a tie). */
function commonTexts(gathered: readonly Gathered[], texts: Texts): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const { library } of gathered) {
    for (const licence of library.licences) {
      const id = reads(texts.text(licence.text));
      if (!id) continue;
      const count = counts.get(id) ?? new Map<string, number>();
      count.set(licence.text, (count.get(licence.text) ?? 0) + 1);
      counts.set(id, count);
    }
  }
  return new Map(
    [...counts].map(([id, count]) => [
      id,
      [...count].sort(([a, n], [b, m]) => m - n || a.localeCompare(b))[0]?.[0] as string,
    ]),
  );
}

// --- the whole part --------------------------------------------------------------

/**
 * librsvg's meson builds `cargo cbuild -p librsvg-c`, with the feature avif
 * only when it finds dav1d and pixbuf when it finds gdk-pixbuf: sharp-libvips
 * builds neither.
 */
const ROOT_CRATE = "librsvg-c";

/** The crates of librsvg's build for the platform, with sharp-libvips' edits of its manifests. */
async function librsvgCrates(
  rsvg: Built,
  row: Row,
  version: string,
  source: Source,
): Promise<Crate[]> {
  const { repo, ref } = row;
  if (!repo || !ref) throw new Error("librsvg's row names no repository for its Cargo files");
  const commit = await source.commit(gitUrl(repo), ref(version));
  const file = (path: string) => source.text(fileAt(repo, commit, path).fetch);
  for (const patch of rsvg.patches) {
    const touched = [...(await source.text(patch)).matchAll(/^diff --git a\/(\S+) b\//gm)].map(
      (m) => m[1] as string,
    );
    const cargo = touched.filter((path) => /(^|\/)Cargo\.(toml|lock)$/.test(path));
    if (cargo.length > 0)
      throw new Error(`${patch} changes ${cargo.join(", ")}, which the resolution does not apply`);
  }
  const workspace = parseToml(
    applyEdits("Cargo.toml", await file("Cargo.toml"), rsvg.edits),
  ) as Table;
  const lock = parseLock(await file("Cargo.lock"));
  const shared = (workspace.workspace as Table).dependencies as Table;
  // The workspace's members: the one this build makes and those its workspace dependencies name by path.
  const members = new Set([ROOT_CRATE]);
  for (const entry of Object.values(shared)) {
    const path = (entry as Table).path;
    if (typeof path === "string") members.add(path);
  }
  const memberManifests = new Map<string, Manifest>();
  for (const dir of members) {
    const path = `${dir}/Cargo.toml`;
    const manifest = parseManifest(applyEdits(path, await file(path), rsvg.edits), workspace);
    memberManifests.set(manifest.name, manifest);
  }
  return resolveCrates(lock, { name: ROOT_CRATE, features: [] }, async (locked) => {
    if (!locked.source) {
      const manifest = memberManifests.get(locked.name);
      if (!manifest) throw new Error(`librsvg's workspace member ${locked.name} was not read`);
      return { locked, manifest, files: null };
    }
    if (locked.source !== "registry+https://github.com/rust-lang/crates.io-index") {
      throw new Error(
        `${locked.name} ${locked.version} comes from ${locked.source}, not crates.io`,
      );
    }
    return crateFile(locked, source);
  });
}

/** A .crate of static.crates.io, held to Cargo.lock's checksum when the lock gives one. */
async function crateFile(locked: Locked, source: Source): Promise<Crate> {
  const { name, version } = locked;
  const bytes = await source.bytes(
    `https://static.crates.io/crates/${name}/${name}-${version}.crate`,
  );
  if (locked.checksum && sha256(bytes) !== locked.checksum) {
    throw new Error(`${name}-${version}.crate is not the one Cargo.lock names`);
  }
  const files = untar(gunzipSync(bytes));
  const toml = files.get(`${name}-${version}/Cargo.toml`);
  if (!toml) throw new Error(`${name}-${version}.crate holds no Cargo.toml`);
  return { locked, manifest: parseManifest(decoder.decode(toml)), files };
}

function byName(a: Library, b: Library): number {
  return a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name);
}

/** The installed sharp's manifest, for the node-addon-api its addon is compiled with. */
export type Sharp = { version: string; devDependencies?: Record<string, string> };

/**
 * notices/libvips.json for sharp-libvips `version`: the libraries posix.sh
 * builds for linux-arm64v8 with LIBRARIES' rows, librsvg's crates, Rust's
 * standard library and its crates, and node-addon-api, which sharp's addon
 * is compiled with: libvips first, then the libraries by name, then Rust's,
 * then the addon's.
 */
export async function gatherLibvips(
  version: string,
  sharp: Sharp,
  source: Source,
  rows: Readonly<Record<string, Row>> = LIBRARIES,
): Promise<LibvipsPart> {
  const tag = `v${version}`;
  const at = (file: string) => source.text(`${SHARP_LIBVIPS}/${tag}/${file}`);
  const versions = parseProperties(await at("versions.properties"));
  const env = { ...dockerEnv(await at(`platforms/${PLATFORM}/Dockerfile`)), LINUX: "true" };
  const built = builtLibraries(await at("build/posix.sh"), versions, env);
  const table = usedUnder(await at("THIRD-PARTY-NOTICES.md"));

  const meta = JSON.parse(
    await source.text(`https://registry.npmjs.org/${PACKAGE}/${version}`),
  ) as {
    dist: { tarball: string; integrity: string };
  };
  const tarball = await source.bytes(meta.dist.tarball);
  const [algorithm, digest] = meta.dist.integrity.split("-");
  if (
    createHash(algorithm as string)
      .update(tarball)
      .digest("base64") !== digest
  ) {
    throw new Error(`${meta.dist.tarball} is not the package the registry names`);
  }
  const packed = untar(gunzipSync(tarball));
  const packaged = JSON.parse(decoder.decode(packed.get("package/versions.json"))) as Record<
    string,
    string
  >;
  if (
    JSON.stringify(Object.entries(packaged).sort()) !==
    JSON.stringify(Object.entries(versions).sort())
  ) {
    throw new Error(`${PACKAGE} ${version}'s versions.json is not versions.properties of ${tag}`);
  }
  const library = [...packed].find(([path]) => /^package\/lib\/libvips-cpp\.so\./.test(path))?.[1];
  if (!library) throw new Error(`${PACKAGE} ${version} holds no libvips-cpp.so`);

  const unknown = built.filter((b) => !rows[b.key]);
  if (unknown.length > 0) {
    throw new Error(
      `build/posix.sh builds ${unknown.map((b) => b.key).join(", ")}, which LIBRARIES has no row for: add one`,
    );
  }
  const unused = Object.keys(rows).filter((key) => !built.some((b) => b.key === key));
  if (unused.length > 0) {
    throw new Error(`LIBRARIES has a row the build no longer needs: ${unused.join(", ")}`);
  }
  const rsvg = built.find((b) => b.key === "rsvg");
  if (!rsvg) throw new Error("build/posix.sh builds no librsvg, whose Rust this part is made for");

  const texts = new Texts();
  const lgplText = normaliseText(await source.text(LGPL));
  const gplText = normaliseText(await source.text(GPL));
  const libraries: Library[] = [];
  for (const b of built) {
    const host = rows[b.key] as Row;
    for (const row of [host, ...(host.vendored ?? [])]) {
      const name = row.row ?? row.name;
      const used = table.get(name);
      if (!used) throw new Error(`sharp-libvips' THIRD-PARTY-NOTICES.md names no ${name}`);
      if ((used === "LGPLv3") !== Boolean(row.lgpl)) {
        throw new Error(`sharp-libvips uses ${name} under ${used}, its row under ${row.license}`);
      }
      libraries.push({
        name: row.name,
        version: versions[b.key] as string,
        license: row.license,
        // A vendored library is in the release; the patches are the host's.
        source: row === host ? [b.tarball, ...b.patches] : [b.tarball],
        licences: await rowLicences(row, host, versions[b.key] as string, source, texts, lgplText),
      });
    }
  }
  const vips = libraries.find((l) => l.name === "libvips") as Library;
  const others = libraries.filter((l) => l !== vips).sort(byName);

  const rust = rustOf(library.subarray());
  const rustRepo = github("rust-lang/rust");
  const std: Library = {
    name: "Rust's standard library (in librsvg)",
    version: rust.version,
    license: "MIT OR Apache-2.0, used under MIT",
    source: [`https://github.com/rust-lang/rust/tree/${rust.commit}`],
    licences: await Promise.all(
      ["COPYRIGHT", "LICENSE-MIT"].map(async (file) => {
        const { fetch, page } = fileAt(rustRepo, rust.commit, file);
        return texts.licence(page, normaliseText(await source.text(fetch)));
      }),
    ),
  };

  const ofRsvg = (
    await librsvgCrates(rsvg, rows.rsvg as Row, versions.rsvg as string, source)
  ).filter((c) => c.files);
  // A crate both are built with (miniz_oxide 0.9.1) is listed once, as librsvg's;
  // no lock names the checksums of the standard library's.
  const inRsvg = new Set(ofRsvg.map((c) => `${c.manifest.name} ${c.manifest.version}`));
  const ofStd = await Promise.all(
    rust.crates
      .filter((c) => !inRsvg.has(`${c.name} ${c.version}`))
      .map((c) => crateFile({ ...c, dependencies: [] }, source)),
  );
  const gathered = [
    ...ofStd.map((c) =>
      crateLibrary(c, "Rust crate in Rust's standard library, in librsvg", texts),
    ),
    ...ofRsvg.map((c) => crateLibrary(c, "Rust crate in librsvg", texts)),
  ];
  const common = commonTexts(gathered, texts);
  for (const { library, owed } of gathered) {
    for (const { id, from } of owed) {
      const text = common.get(id);
      if (!text) throw new Error(`${library.name} owes ${id}'s text, which no crate carries`);
      library.licences.push(texts.of(from, text));
    }
  }
  const crates = (label: string) =>
    gathered
      .map((g) => g.library)
      .filter((l) => l.name.endsWith(`(${label})`))
      .sort(byName);

  const addonApi = sharp.devDependencies?.["node-addon-api"]?.replace(/^[\^~]/, "");
  if (!addonApi) throw new Error(`sharp ${sharp.version} names no node-addon-api`);
  const addonRepo = github("nodejs/node-addon-api");
  const addonCommit = await source.commit(gitUrl(addonRepo), v(addonApi));
  const addonFile = fileAt(addonRepo, addonCommit, "LICENSE.md");
  // shortcut: the floor of sharp's range; the addon's prebuild may have
  // resolved a later 8.x. sharp's prebuild logs would name the one it used.
  const addon: Library = {
    name: "node-addon-api (in sharp's addon)",
    version: addonApi,
    license: "MIT",
    source: [`https://github.com/nodejs/node-addon-api/tree/${v(addonApi)}`],
    licences: [texts.licence(addonFile.page, normaliseText(await source.text(addonFile.fetch)))],
  };

  const mpl2 = common.get("MPL-2.0");
  if (!mpl2)
    throw new Error("no crate carries MPL-2.0's text, which the notices' introduction names");
  const all = [
    vips,
    ...others,
    std,
    ...crates("Rust crate in Rust's standard library, in librsvg"),
    ...crates("Rust crate in librsvg"),
    addon,
  ];
  const gpl = texts.licence(GPL, gplText, undefined, true);
  const kept = new Map<string, string>();
  for (const licence of [...all.flatMap((l) => l.licences), gpl]) {
    if (!kept.has(licence.text)) kept.set(licence.text, texts.copyOf(licence));
  }
  return {
    package: PACKAGE,
    version,
    build: `https://github.com/lovell/sharp-libvips/tree/${tag}`,
    versions: packaged,
    lgpl: textKey(lgplText),
    gpl: gpl.text,
    mpl2,
    libraries: all,
    texts: Object.fromEntries([...kept].sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** The commit `git ls-remote <url> refs/tags/<tag> refs/tags/<tag>^{}` names: the peeled one of an annotated tag. */
export function lsRemoteCommit(output: string, tag: string): string {
  const refs = new Map(
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [commit, ref] = line.split("\t");
        return [ref as string, commit as string];
      }),
  );
  const commit = refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
  if (!commit) throw new Error(`no tag ${tag}`);
  return commit;
}
