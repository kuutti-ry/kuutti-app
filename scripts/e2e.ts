/**
 * e2e: the Maestro flows on a booted simulator (#164, ADR-020).
 *
 *   pnpm e2e                                   every flow under apps/mobile/e2e/flows (config.yaml)
 *   pnpm e2e -- --device <udid>                one simulator, booted for the run and shut down after
 *   pnpm e2e -- apps/mobile/e2e/flows/x.yaml   one flow
 *   pnpm e2e -- --shard 2/4                    the second of four stretches of the order (CI's jobs)
 *
 * The flows start from the cast's stories, so `pnpm demo:reset` comes first,
 * and the photo flows take their pictures from the release `pnpm demo:assets`
 * fetched: it is copied to `apps/mobile/e2e/media` (git ignores it), since
 * Maestro's addMedia reads files inside the flows' workspace and does not
 * follow a link out of it. Homebrew's OpenJDK, which Maestro needs, is
 * keg-only, so it is put on the PATH here.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, parseAllDocuments, stringify } from "yaml";
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
const shardAt = args.indexOf("--shard");
const shard = shardAt >= 0 ? args.splice(shardAt, 2)[1] : undefined;
const single = args.some((arg) => arg.endsWith(".yaml"));
const config = single ? [] : planRun(shard);
// A simulator named by its UDID is booted if it is not and shut down after the run, passed or
// failed: left booted between runs, one gathered 127 web content processes, some 6 GB, in an
// hour of runs (11/10/2026). An emulator's serial cannot start it again, so Android stays up.
const simulator = global.find((arg) => /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(arg));
if (simulator) spawnSync("xcrun", ["simctl", "bootstatus", simulator, "-b"], { stdio: "inherit" });
const target = single ? [] : [WORKSPACE];
// A second Metro (a worktree's beside the checkout's) is named by its port.
const metro = process.env.METRO_PORT ? ["-e", `METRO_PORT=${process.env.METRO_PORT}`] : [];

// Off a Mac (CI) there is no Homebrew, and the job puts its own JDK on the PATH.
const brew = spawnSync("brew", ["--prefix", "openjdk"], { encoding: "utf8" });
const jdk = brew.status === 0 ? `${brew.stdout.trim()}/bin:` : "";
const run = spawnSync("maestro", [...global, "test", ...config, ...metro, ...args, ...target], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, PATH: `${jdk}${process.env.PATH ?? ""}` },
});
if (simulator) spawnSync("xcrun", ["simctl", "shutdown", simulator], { stdio: "inherit" });
process.exit(run.status ?? 1);

/**
 * The order of config.yaml held to the flows, and for `--shard i/n` a config of the i-th stretch,
 * passed to Maestro with --config. Maestro knows a flow in the order by its name and cuts the
 * sequence short at a name it cannot find, without a word, so a flow left out, a name no flow has
 * and a name twice are refused here. A stretch is cut where the running weight passes i/n of the
 * whole, so a persona's flows stay on one device as far as the cut allows (#226).
 */
function planRun(shard: string | undefined): string[] {
  const dir = resolve(ROOT, WORKSPACE);
  const order: string[] = parse(readFileSync(join(dir, "config.yaml"), "utf8")).executionOrder
    .flowsOrder;
  const flows = new Map<string, { file: string; weight: number }>();
  for (const file of readdirSync(join(dir, "flows")).filter((name) => name.endsWith(".yaml"))) {
    const text = readFileSync(join(dir, "flows", file), "utf8");
    const name: string = parseAllDocuments(text)[0]?.toJS()?.name ?? file.replace(/\.yaml$/, "");
    flows.set(name, { file, weight: weightOf(text) });
  }
  const problems = [
    ...[...flows]
      .filter(([name]) => !order.includes(name))
      .map(([, flow]) => `flows/${flow.file} is not in the order`),
    ...order.filter((name) => !flows.has(name)).map((name) => `no flow is named "${name}"`),
    ...order
      .filter((name, i) => order.indexOf(name) !== i)
      .map((name) => `"${name}" is in the order twice`),
  ];
  if (problems.length > 0) {
    console.error(
      `e2e: ${WORKSPACE}/config.yaml's executionOrder and the flows differ:\n  ${problems.join("\n  ")}`,
    );
    process.exit(1);
  }
  if (shard === undefined) return [];

  const [i, n] = shard.split("/").map(Number);
  if (!Number.isInteger(i) || !Number.isInteger(n) || i < 1 || i > n) {
    console.error(`e2e: --shard wants i/n with 1 <= i <= n, not ${shard}`);
    process.exit(1);
  }
  const total = order.reduce((sum, name) => sum + (flows.get(name)?.weight ?? 0), 0);
  let before = 0;
  const part = order.filter((name) => {
    const weight = flows.get(name)?.weight ?? 0;
    const at = Math.min(n - 1, Math.floor(((before + weight / 2) * n) / total));
    before += weight;
    return at === i - 1;
  });
  if (part.length === 0) {
    console.log(`e2e: shard ${shard} has no flows`);
    process.exit(0);
  }
  const file = join(mkdtempSync(join(tmpdir(), "kuutti-e2e-")), "config.yaml");
  const flowsOf = part.map((name) => `flows/${flows.get(name)?.file}`);
  writeFileSync(
    file,
    stringify(
      { flows: flowsOf, executionOrder: { continueOnFailure: true, flowsOrder: part } },
      { lineWidth: 0 },
    ),
  );
  console.log(
    `e2e: shard ${shard}, ${part.length} of ${order.length} flows: ${flowsOf.join(", ")}`,
  );
  return ["--config", file];
}

/**
 * A flow's share of a run: its commands, about 3 s each on CI's emulator, and a sign-in as ten of
 * them. Against the flows' times in CI run 38129841196 it correlates at 0.9; commands alone, 0.7.
 */
function weightOf(text: string): number {
  const body = text.slice(text.indexOf("\n---\n"));
  const commands = body.match(/^\s*- [a-zA-Z]/gm)?.length ?? 0;
  const signIns = body.match(/common\/(sign-in|bank-login)\.yaml/g)?.length ?? 0;
  return commands + 10 * signIns;
}
