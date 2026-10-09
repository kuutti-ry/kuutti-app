/**
 * The demo's pictures (#142, ADR-014 §7): a release of the private photos
 * repository, fetched into the cache and verified against the manifest this
 * repository holds, or the manifest written from a directory of pictures.
 *
 *   pnpm demo:assets                       fetch release v1 into ~/.cache/kuutti-demo-photos/v1 and verify it
 *   pnpm demo:assets -- --tag v2           another release (the manifest must be that release's)
 *   pnpm demo:assets -- --check <dir>      verify a directory against the manifest; nothing is fetched
 *   pnpm demo:assets -- --manifest <dir>   write packages/db/src/seed/photos-manifest.ts from a directory of pictures
 *
 * A release is a tag (the photos repository's README), fetched as the tag's
 * tarball through `gh api`: the tree keeps `faces/<set>/` and `negatives/`,
 * which release assets cannot, since their names carry no slash. The
 * repository is private, so a contributor needs read access and a signed-in
 * gh. A file whose checksum
 * differs from the manifest's, a listed file that is missing and a picture
 * that is not listed are each named, and the command fails; the loaders
 * refuse the same cache (`loadAssets`). `--manifest` is the maintainer's
 * step after generating the pictures (docs/demo/photo-prompts.md): the same
 * file goes into the release as manifest.json.
 */
import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  demoAssetsDir,
  manifestOf,
  PHOTOS_MANIFEST,
  PHOTOS_RELEASE,
  PHOTOS_REPO,
  renderManifest,
  verifyAssets,
} from "@kuutti/db/demo";

const run = promisify(execFile);
const MANIFEST_FILE = resolve(
  import.meta.dirname,
  "../../../packages/db/src/seed/photos-manifest.ts",
);

function fail(message: string, code = 2): never {
  console.error(`✖ ${message}`);
  process.exit(code);
}

// pnpm hands the separator through.
const args = process.argv.slice(2).filter((arg, i) => !(arg === "--" && i === 0));
let tag = PHOTOS_RELEASE;
let check: string | undefined;
let manifest: string | undefined;
const seen = new Set<string>();
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i] as string;
  const equals = arg.indexOf("=");
  const flag = equals > 0 ? arg.slice(0, equals) : arg;
  if (seen.has(flag)) fail(`${flag} is given twice`);
  seen.add(flag);
  const value = () => {
    if (equals > 0) return arg.slice(equals + 1);
    i += 1;
    return args[i];
  };
  if (flag === "--tag") tag = value() ?? fail("--tag takes a release tag");
  else if (flag === "--check") check = value() ?? fail("--check takes a directory");
  else if (flag === "--manifest") manifest = value() ?? fail("--manifest takes a directory");
  else fail(`unknown argument ${arg}: --tag, --check and --manifest are all there is`);
}
if (check && manifest) fail("--check and --manifest exclude each other");

if (manifest) {
  const assets = manifestOf(resolve(manifest));
  if (assets.length === 0)
    fail(`no pictures under ${manifest}: faces/<persona>/, faces/pool/, negatives/`);
  writeFileSync(MANIFEST_FILE, renderManifest(assets));
  const purposes: Record<string, number> = {};
  for (const asset of assets) purposes[asset.purpose] = (purposes[asset.purpose] ?? 0) + 1;
  console.log(
    JSON.stringify({
      msg: "demo assets: manifest written",
      file: MANIFEST_FILE,
      pictures: assets.length,
      purposes,
    }),
  );
  process.exit(0);
}

if (PHOTOS_MANIFEST.length === 0) {
  fail(
    "the manifest is empty: there is no release yet. Generate the pictures (docs/demo/photo-prompts.md), write the manifest with --manifest <dir>, release them, then fetch",
  );
}

const dir = check ? resolve(check) : demoAssetsDir(tag);
if (!check) {
  mkdirSync(dir, { recursive: true });
  try {
    const { stdout } = await run("gh", ["api", `repos/${PHOTOS_REPO}/tarball/${tag}`], {
      encoding: "buffer",
      maxBuffer: 512 * 1024 * 1024,
    });
    const tarball = join(tmpdir(), `kuutti-demo-photos-${process.pid}.tar.gz`);
    writeFileSync(tarball, stdout);
    // The tarball's one top directory is named after the commit; its contents are the release.
    await run("tar", ["-xzf", tarball, "--strip-components=1", "-C", dir]).finally(() =>
      rmSync(tarball, { force: true }),
    );
  } catch (error) {
    fail(
      `fetching ${tag} of ${PHOTOS_REPO} failed: ${error instanceof Error ? error.message.split("\n")[0] : "unknown"}. Is gh signed in with read access to the private repository?`,
    );
  }
}
const problems = verifyAssets(dir, PHOTOS_MANIFEST);
if (problems.length > 0) {
  for (const problem of problems) console.error(`✖ ${problem.path}: ${problem.problem}`);
  fail(
    `${problems.length} of the pictures in ${dir} are not the release's; nothing of them is used`,
  );
}
console.log(
  JSON.stringify({ msg: "demo assets: verified", dir, pictures: PHOTOS_MANIFEST.length, tag }),
);
