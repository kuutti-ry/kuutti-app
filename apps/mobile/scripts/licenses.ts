/**
 * The packages whose code ships in the app, with the texts their licences ask
 * to go with every copy, for the licences screen in Settings, in every build
 * (#143, #287, #177, #416).
 *
 * A notice is owed for every package whose code is distributed, a transitive
 * dependency as much as a direct one; and most of what node_modules holds
 * never reaches a phone (Jest, Babel, the CLIs, the web target). What ships is
 * what Metro bundles, so the script exports the production bundles of both
 * phone platforms with their source maps, as the update lane does
 * (preview.yml, deploy.yml), and keeps the packages whose files the maps name.
 * Without Hermes bytecode and without minifying: neither changes the module
 * set (the same 113 package directories either way, 15/10/2026), and hermesc
 * has no arm64 Linux binary, which CI's test-mobile runs on. The native
 * libraries the pods and gradle bring (folly, OkHttp, Fresco) are not in
 * node_modules and are not listed: #177's second list.
 *
 * Each package carries its copyright lines, its licence text and any NOTICE,
 * read from the directory the maps name (@kuutti/notices): Hermes bytecode
 * keeps no header comment, and MIT, ISC and BSD-3-Clause ask for the notice in
 * every copy (#416). A package that ships no licence file takes its row of
 * UPSTREAM below; a package with neither fails the run.
 *
 *   pnpm --filter mobile run licenses
 *
 * writes src/generated/licenses.json, which is committed. CI runs the same
 * command and fails on a diff (ci.yml, test-mobile); the test next to this
 * file holds the committed list to the installed versions without an export,
 * so a bump without a fresh run fails locally in seconds. pnpm has a
 * `licenses` command of its own, which shadows the script without `run`, and
 * which cannot read a hoisted install (it answers "Unknown" for everything):
 * hence this.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  collectNotices,
  licenseOf,
  type Manifest,
  type Notices,
  type PackageNotices,
  shippedPackageDirs,
  type Upstream,
} from "@kuutti/notices";

export type LicenseEntry = { name: string; version: string; license: string };

/** What the licences screen reads: the packages, and each text they name as its paragraphs. */
export type LicenceList = { packages: PackageNotices[]; texts: Record<string, string[]> };

// Jest loads this file as CommonJS for scripts/licenses.test.ts, where Babel leaves
// import.meta empty and __dirname stands in; Node runs it as a module.
const HERE = typeof __dirname === "string" ? __dirname : import.meta.dirname;
const APP = resolve(HERE, "..");
const ROOT = resolve(APP, "../..");
export const OUTPUT = join(APP, "src", "generated", "licenses.json");

const EXPO = "https://github.com/expo/expo/blob/50ac74f1ab5682c8e32b24da6e5e97dd4dbbb80f";
const REACT_NATIVE = "https://github.com/react/react-native/blob/v0.86.3";
// Expo's root licence is expo's own LICENSE, byte for byte; Meta's is react-native's.
const expo: Upstream = {
  copyright: ["Copyright (c) 2015-present 650 Industries, Inc. (aka Expo)"],
  like: "expo",
  from: `${EXPO}/LICENSE`,
};
const meta = (from: string): Upstream => ({
  copyright: ["Copyright (c) Meta Platforms, Inc. and affiliates."],
  like: "react-native",
  from,
});

/**
 * The shipped packages that carry no licence file of their own (#416), each
 * with the upstream licences that cover what it ships: the copyright line,
 * the address it was read at, pinned to the commit or tag of the version
 * read (22/10/2026), and the shipped package whose file has upstream's text.
 * Expo's and React Native's packages fall under their repository's root
 * licence. expo-router bundles its own copy of React Navigation, whose
 * licence upstream keeps beside the code and leaves out of the package;
 * console.js of the polyfills carries Node's inspect() under Joyent's notice.
 * A row nothing needs fails the run, as does a package missing from here.
 */
export const UPSTREAM: Readonly<Record<string, readonly Upstream[]>> = {
  "@expo/ui": [expo],
  "expo-router": [
    expo,
    {
      copyright: ["Copyright (c) 2017 React Navigation Contributors"],
      like: "expo",
      from: `${EXPO}/packages/expo-router/src/react-navigation/LICENCE`,
    },
  ],
  "expo-updates": [expo],
  "@react-native/assets-registry": [meta(`${REACT_NATIVE}/LICENSE`)],
  "@react-native/js-polyfills": [
    meta(`${REACT_NATIVE}/LICENSE`),
    {
      copyright: ["Copyright Joyent, Inc. and other Node contributors."],
      like: "react-native",
      from: `${REACT_NATIVE}/packages/polyfills/console.js`,
    },
  ],
  "@react-native/normalize-colors": [meta(`${REACT_NATIVE}/LICENSE`)],
  "@react-native/virtualized-lists": [meta(`${REACT_NATIVE}/LICENSE`)],
  "metro-runtime": [meta("https://github.com/react/metro/blob/v0.84.5/LICENSE")],
  "standard-navigation": [
    {
      copyright: ["Copyright (c) 2026 React Navigation Contributors"],
      like: "react-native",
      from: "https://github.com/react-navigation/standard-navigation/blob/33f3d3c976a24bad9fe32583939318bc143fa41b/LICENSE",
    },
  ],
};

type Dependencies = Manifest & {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

/** The package.json of `name` as Node would resolve it from `from`: the nearest node_modules up to the workspace root. */
function manifestOf(name: string, from: string): { dir: string; manifest: Dependencies } | null {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) {
      return { dir: dirname(candidate), manifest: JSON.parse(readFileSync(candidate, "utf8")) };
    }
    if (dir === ROOT || dirname(dir) === dir) return null;
    dir = dirname(dir);
  }
}

/**
 * Every third-party package reachable from the app's dependencies through the
 * install, once, sorted by name and version: the superset the shipped list is
 * drawn from, and what the test holds the committed list to. Workspace
 * packages are ours (AGPL-3.0, not a third party's licence to list); their
 * dependencies are followed, since what @kuutti/schema imports ships as much
 * as what the app imports. Not optionalDependencies: they are the installing
 * machine's (fsevents on a Mac, one of @sentry/cli's platform binaries), never
 * the app's, and the list must come out the same on every machine.
 */
export function installedPackages(app: string = APP): LicenseEntry[] {
  const own: Dependencies = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  const visited = new Set<string>();
  const seen = new Map<string, LicenseEntry>();
  const queue: Array<{ name: string; from: string }> = Object.keys(own.dependencies ?? {}).map(
    (name) => ({ name, from: app }),
  );
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const found = manifestOf(next.name, next.from);
    if (!found) continue; // not installed here: nothing to read
    const { manifest } = found;
    const key = `${manifest.name ?? next.name}@${manifest.version ?? "?"}`;
    if (visited.has(key)) continue;
    visited.add(key);
    // Workspace packages are symlinked into node_modules, so the real path tells
    // them apart from a third party that pnpm nested under apps/mobile/node_modules.
    const dir = realpathSync(found.dir);
    if (dir.includes(`${sep}node_modules${sep}`)) {
      seen.set(key, {
        name: manifest.name ?? next.name,
        version: manifest.version ?? "?",
        license: licenseOf(manifest),
      });
    }
    const optionalPeers = new Set(
      Object.entries(manifest.peerDependenciesMeta ?? {})
        .filter(([, meta]) => meta.optional)
        .map(([name]) => name),
    );
    for (const name of Object.keys(manifest.dependencies ?? {})) queue.push({ name, from: dir });
    for (const name of Object.keys(manifest.peerDependencies ?? {})) {
      if (!optionalPeers.has(name)) queue.push({ name, from: dir });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
}

const LIST_ITEM = /^([-*•]|\d+[.)]|\([a-z0-9]+\))\s/i;
/** A line shorter than this, in a block of only such lines, was broken on purpose. */
const SHORT = 40;

/**
 * A text as the screen shows it: one string per paragraph (the lines between
 * blank lines), its lines joined into one, since a licence file breaks them
 * at eighty columns for a terminal and a phone wraps them itself at the
 * reader's text size. A line that starts a list item keeps its break, and so
 * does every line of a block of short lines (a title, an address), which the
 * file broke on purpose. The words stay the file's, in its order.
 */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.every((line) => line.length < SHORT)) return lines.join("\n");
      return lines
        .map((line, index) => (index === 0 ? line : `${LIST_ITEM.test(line) ? "\n" : " "}${line}`))
        .join("");
    })
    .filter(Boolean);
}

/** The screen's list: the packages as collected, each text as its paragraphs. */
export function licenceList(notices: Notices): LicenceList {
  return {
    packages: notices.packages,
    texts: Object.fromEntries(
      Object.entries(notices.texts).map(([key, text]) => [key, paragraphs(text)]),
    ),
  };
}

/**
 * The production bundles of both phone platforms with their source maps, as the
 * update lane exports them, into `outDir`; the web target is the preview's,
 * not a phone's. Expo's own CLI through this Node, so nothing on PATH is
 * needed; CI=1 keeps the CLI from asking anything.
 */
function exportBundles(outDir: string): void {
  const expo = manifestOf("expo", APP);
  if (!expo) throw new Error("expo is not installed; run pnpm install");
  const result = spawnSync(
    process.execPath,
    [
      join(expo.dir, "bin", "cli"),
      "export",
      "--output-dir",
      outDir,
      "--source-maps",
      "--no-bytecode",
      "--no-minify",
      "--platform",
      "ios",
      "--platform",
      "android",
    ],
    {
      cwd: APP,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CI: "1" },
    },
  );
  if (result.status !== 0) {
    process.stderr.write(`${result.stdout}${result.stderr}`);
    throw new Error(`expo export failed with ${result.status ?? result.signal}`);
  }
}

/** The `sources` of every source map the export wrote, both platforms together. */
function sourcesOf(exportDir: string): string[] {
  const js = join(exportDir, "_expo", "static", "js");
  const maps = readdirSync(js, { recursive: true, encoding: "utf8" }).filter((f) =>
    f.endsWith(".map"),
  );
  if (maps.length === 0) throw new Error(`expo export wrote no source map under ${js}`);
  return maps.flatMap((map) => {
    const { sources } = JSON.parse(readFileSync(join(js, map), "utf8")) as { sources?: unknown };
    if (!Array.isArray(sources)) throw new Error(`${map} has no sources list`);
    return sources.filter((s): s is string => typeof s === "string");
  });
}

/** Exports into a temporary directory, reads the packages the bundles are made of with their texts, and removes the export. */
function shippedLicences(): LicenceList {
  const out = mkdtempSync(join(tmpdir(), "kuutti-licenses-"));
  try {
    exportBundles(out);
    return licenceList(collectNotices(shippedPackageDirs(sourcesOf(out), ROOT), UPSTREAM));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const SELF = import.meta.filename;
if (process.argv[1] && SELF && resolve(process.argv[1]) === resolve(SELF)) {
  console.log(
    "licenses: exporting the ios and android bundles with their source maps (expo export)…",
  );
  const list = shippedLicences();
  writeFileSync(OUTPUT, `${JSON.stringify(list, null, 2)}\n`);
  console.log(
    `✔ licenses: ${list.packages.length} packages ship, ${Object.keys(list.texts).length} distinct texts; written to src/generated/licenses.json`,
  );
}
