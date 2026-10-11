/**
 * The packages this app is made of, with their licences, for the tech config
 * screen (#143): walks the app's dependencies through the hoisted node_modules
 * of the workspace, reads each package.json once, and writes
 * src/generated/licenses.json, which is committed. `pnpm licenses` cannot
 * read a hoisted install (it answers "Unknown" for everything), hence this.
 *
 *   pnpm --filter mobile licenses
 *
 * A test holds the file to a fresh run, so a dependency change that forgets
 * the command fails in CI.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export type LicenseEntry = { name: string; version: string; license: string };

const APP = resolve(import.meta.dirname, "..");
const ROOT = resolve(APP, "../..");
export const OUTPUT = join(APP, "src", "generated", "licenses.json");

type Manifest = {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
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

/** Every package reachable from the app's dependencies, once, sorted by name and version. */
export function collectLicenses(app: string = APP): LicenseEntry[] {
  const own: Manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  const seen = new Map<string, LicenseEntry>();
  const queue: Array<{ name: string; from: string }> = Object.keys(own.dependencies ?? {}).map(
    (name) => ({ name, from: app }),
  );
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const found = manifestOf(next.name, next.from);
    if (!found) continue; // an optional dependency that is not installed on this platform
    const { dir, manifest } = found;
    const key = `${manifest.name ?? next.name}@${manifest.version ?? "?"}`;
    if (seen.has(key)) continue;
    // Workspace packages are ours: AGPL-3.0, and not a third party's licence to
    // list. They are symlinked into node_modules, so the real path tells them
    // apart from a third party that pnpm nested under apps/mobile/node_modules.
    if (!realpathSync(dir).includes(`${sep}node_modules${sep}`)) continue;
    seen.set(key, {
      name: manifest.name ?? next.name,
      version: manifest.version ?? "?",
      license: licenseOf(manifest),
    });
    const optionalPeers = new Set(
      Object.entries(manifest.peerDependenciesMeta ?? {})
        .filter(([, meta]) => meta.optional)
        .map(([name]) => name),
    );
    for (const name of Object.keys(manifest.dependencies ?? {})) queue.push({ name, from: dir });
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
      queue.push({ name, from: dir });
    }
    for (const name of Object.keys(manifest.peerDependencies ?? {})) {
      if (!optionalPeers.has(name)) queue.push({ name, from: dir });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
}

export function renderLicenses(entries: LicenseEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const entries = collectLicenses();
  writeFileSync(OUTPUT, renderLicenses(entries));
  console.log(`✔ licenses: ${entries.length} packages to src/generated/licenses.json`);
}
