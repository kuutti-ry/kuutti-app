/**
 * The packages whose code ships in the app, with their licences, for the
 * licences screen in Settings, in every build (#143, #287, #177).
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
import { basename, dirname, join, resolve, sep } from "node:path";

export type LicenseEntry = { name: string; version: string; license: string };

// Jest loads this file as CommonJS for scripts/licenses.test.ts, where Babel leaves
// import.meta empty and __dirname stands in; Node runs it as a module.
const HERE = typeof __dirname === "string" ? __dirname : import.meta.dirname;
const APP = resolve(HERE, "..");
const ROOT = resolve(APP, "../..");
export const OUTPUT = join(APP, "src", "generated", "licenses.json");

type Manifest = {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

function licenseOf(manifest: Manifest): string {
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

/** The package.json of `name` as Node would resolve it from `from`: the nearest node_modules up to the workspace root. */
function manifestOf(name: string, from: string): { dir: string; manifest: Manifest } | null {
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

function sorted(entries: Iterable<LicenseEntry>): LicenseEntry[] {
  return [...entries].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
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
  const own: Manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
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
  return sorted(seen.values());
}

/**
 * The directory of the package each source file of a bundle belongs to: the
 * path up to the name after the last `node_modules` segment, a scope and its
 * name as one, so a nested copy is its own package and a package's inner
 * package.json (an ESM marker) never passes for one. Expo names the sources
 * from the workspace root (`/node_modules/react/index.js`,
 * `/apps/mobile/node_modules/expo/src/Expo.ts`); an absolute path under the
 * root is read the same. Metro's virtual modules (`__prelude__`,
 * `\0polyfill:...`), a require.context query (`/apps/mobile/app?ctx=...`) and
 * our own files are not a third party's.
 */
export function shippedPackageDirs(sources: Iterable<string>, root: string = ROOT): string[] {
  const dirs = new Set<string>();
  for (const source of sources) {
    if (source.includes("\0")) continue;
    const file = source.split("?")[0] ?? "";
    const fromRoot = file.startsWith(`${root}/`) ? file.slice(root.length) : file;
    if (!fromRoot.startsWith("/")) continue;
    const segments = fromRoot.slice(1).split("/");
    const at = segments.lastIndexOf("node_modules");
    if (at < 0) continue;
    const name = segments[at + 1];
    const end = name?.startsWith("@") ? at + 3 : at + 2;
    if (!name || segments.length <= end) continue; // no file inside a package: nothing shipped from it
    dirs.add(join(root, ...segments.slice(0, end)));
  }
  return [...dirs].sort();
}

/** The packages of `dirs`, each once by name and version, sorted by name and version. */
export function collectLicenses(dirs: Iterable<string>): LicenseEntry[] {
  const seen = new Map<string, LicenseEntry>();
  for (const dir of dirs) {
    const manifest: Manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const entry = {
      name: manifest.name ?? basename(dir),
      version: manifest.version ?? "?",
      license: licenseOf(manifest),
    };
    seen.set(`${entry.name}@${entry.version}`, entry);
  }
  return sorted(seen.values());
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

/** Exports into a temporary directory, reads the packages the bundles are made of, and removes the export. */
function shippedLicenses(): LicenseEntry[] {
  const out = mkdtempSync(join(tmpdir(), "kuutti-licenses-"));
  try {
    exportBundles(out);
    return collectLicenses(shippedPackageDirs(sourcesOf(out)));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const SELF = import.meta.filename;
if (process.argv[1] && SELF && resolve(process.argv[1]) === resolve(SELF)) {
  console.log(
    "licenses: exporting the ios and android bundles with their source maps (expo export)…",
  );
  const entries = shippedLicenses();
  writeFileSync(OUTPUT, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(
    `✔ licenses: ${entries.length} packages ship; written to src/generated/licenses.json`,
  );
}
