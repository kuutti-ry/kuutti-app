/**
 * e2e: the Maestro flows on a booted simulator (#164, ADR-020).
 *
 *   pnpm e2e                                   every flow under apps/mobile/e2e/flows (config.yaml)
 *   pnpm e2e -- --device <udid>                one simulator of two booted
 *   pnpm e2e -- apps/mobile/e2e/flows/x.yaml   one flow
 *
 * The flows start from the cast's stories, so `pnpm demo:reset` comes first,
 * and the photo flows take their pictures from the release `pnpm demo:assets`
 * fetched: it is copied to `apps/mobile/e2e/media` (git ignores it), since
 * Maestro's addMedia reads files inside the flows' workspace and does not
 * follow a link out of it. Homebrew's OpenJDK, which Maestro needs, is
 * keg-only, so it is put on the PATH here.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, rmSync } from "node:fs";
import { resolve } from "node:path";
// By path: the root is no workspace of @kuutti/db, and this is a command line (the demo tools' rule).
import { demoAssetsDir } from "../packages/db/src/seed/photos.ts";

const ROOT = resolve(import.meta.dirname, "..");
// The workspace: config.yaml there says flows/ is what runs, and common/ and media/ lie inside it.
const WORKSPACE = "apps/mobile/e2e";
const MEDIA = resolve(ROOT, "apps/mobile/e2e/media");

const photos = demoAssetsDir();
if (!existsSync(photos)) {
  console.error(`e2e: no pictures in ${photos}; run pnpm demo:assets first`);
  process.exit(1);
}
// A link left by an earlier version of this script goes; the copy is made anew each run (a few MB).
if (lstatSync(MEDIA, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(MEDIA);
cpSync(photos, MEDIA, { recursive: true, force: true });

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const device = args.indexOf("--device");
const global = device >= 0 ? args.splice(device, 2) : [];
const target = args.some((arg) => arg.endsWith(".yaml")) ? [] : [WORKSPACE];

const brew = spawnSync("brew", ["--prefix", "openjdk"], { encoding: "utf8" });
const jdk = brew.status === 0 ? `${brew.stdout.trim()}/bin:` : "";
const run = spawnSync("maestro", [...global, "test", ...args, ...target], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, PATH: `${jdk}${process.env.PATH ?? ""}` },
});
process.exit(run.status ?? 1);
