/**
 * Gathers notices/libvips.json again (#421): the libvips part of the API
 * image's THIRD_PARTY_NOTICES, for the sharp-libvips the install holds or
 * another release.
 *
 *   pnpm --filter @kuutti/api notices:libvips                    the install's sharp-libvips
 *   pnpm --filter @kuutti/api notices:libvips -- --version 1.3.5 another release
 *
 * The maintainer's step after a sharp bump that moves libvips, which fails
 * the build and the API's tests until it is done (notices/README.md). It
 * reads sharp-libvips' build at the release's tag, each library's licence
 * files at its version's commit, librsvg's crates and the npm package over
 * HTTPS (and tags with `git ls-remote`), writes the file, and formats it
 * with Biome; the diff is what to review. Every download is kept, as data,
 * under ~/.cache/kuutti-libvips-notices, named by its address's digest, so
 * a second run reads them from there; delete the directory to fetch afresh.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gatherLibvips, lsRemoteCommit, type Sharp, type Source } from "./notices/libvips.ts";
import { installedLibvips, LIBVIPS } from "./notices/third-party.ts";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../../..");
const CACHE = join(homedir(), ".cache", "kuutti-libvips-notices");

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(2);
}

// pnpm hands the separator through.
const args = process.argv.slice(2).filter((arg, i) => !(arg === "--" && i === 0));
let version = installedLibvips(ROOT)?.version;
if (args[0] === "--version" && args[1] && args.length === 2) version = args[1];
else if (args.length > 0)
  fail(`unknown arguments ${args.join(" ")}: --version <x> is all there is`);
if (!version) fail("the install holds no @img/sharp-libvips-*: give --version");

mkdirSync(CACHE, { recursive: true });
async function download(url: string): Promise<Uint8Array> {
  const file = join(CACHE, createHash("sha256").update(url).digest("hex"));
  if (existsSync(file)) return readFileSync(file);
  const response = await fetch(url).catch((error: Error) => {
    throw new Error(`${error.message} for ${url}: ${(error.cause as Error | undefined)?.message}`);
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  writeFileSync(file, bytes);
  return bytes;
}

const source: Source = {
  text: async (url) => new TextDecoder().decode(await download(url)),
  bytes: download,
  async commit(repository, ref) {
    // An abbreviated commit (mozjpeg's version) is no ref ls-remote can name.
    const github = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(repository);
    if (/^[0-9a-f]{7,40}$/.test(ref) && github) {
      const response = await fetch(`https://api.github.com/repos/${github[1]}/commits/${ref}`);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${github[1]}@${ref}`);
      return ((await response.json()) as { sha: string }).sha;
    }
    const { stdout } = await run("git", [
      "ls-remote",
      repository,
      `refs/tags/${ref}`,
      `refs/tags/${ref}^{}`,
    ]);
    return lsRemoteCommit(stdout, ref);
  },
};

const sharp: Sharp = JSON.parse(
  readFileSync(join(ROOT, "node_modules", "sharp", "package.json"), "utf8"),
);
try {
  const part = await gatherLibvips(version, sharp, source);
  writeFileSync(LIBVIPS, `${JSON.stringify(part, null, 2)}\n`);
  await run(join(ROOT, "node_modules", ".bin", "biome"), ["format", "--write", LIBVIPS]);
  console.log(
    `✔ notices/libvips.json: ${part.package} ${part.version}, ${part.libraries.length} libraries, ${Object.keys(part.texts).length} texts; review the diff`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
