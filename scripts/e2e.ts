/**
 * e2e: the Maestro flows on a booted simulator (#164, ADR-020).
 *
 *   pnpm e2e                                   every flow under apps/mobile/e2e/flows (config.yaml)
 *   pnpm e2e -- --device <udid>                one simulator, booted for the run and shut down after
 *   pnpm e2e -- apps/mobile/e2e/flows/x.yaml   one flow
 *   pnpm e2e -- --shard 2/4                    the second of four stretches of the order (CI's jobs)
 *   node scripts/e2e.ts --self-test            the command line's cases; copies and runs nothing
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
  mkdirSync,
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

if (process.argv.includes("--self-test")) selfTest();
let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`e2e: ${(error as Error).message}`);
  process.exit(1);
}
const { global, shard, args } = parsed;

const photos = demoAssetsDir();
if (!existsSync(photos)) {
  console.error(`e2e: no pictures in ${photos}; run pnpm demo:assets first`);
  process.exit(1);
}
// A link left by an earlier version of this script goes; the copy is made anew each run (a few MB).
if (lstatSync(MEDIA, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(MEDIA);
cpSync(photos, MEDIA, { recursive: true, force: true });

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

/**
 * --device and --shard are this script's, as `--shard 2/4` or `--shard=2/4`; the rest is Maestro's
 * (flows, --format, -e). A flag without a usable value is refused before anything is copied or
 * booted, never read as no flag: `--shard` last, or before --device, ran every flow (#235).
 */
function parseArgs(argv: string[]): { global: string[]; shard?: string; args: string[] } {
  const args = argv.filter((arg) => arg !== "--");
  const named = (flag: string) => (arg: string) => arg === flag || arg.startsWith(`${flag}=`);
  // A bare --self-test never gets here; with a value it would go to Maestro and the run would start.
  if (args.some(named("--self-test"))) throw new Error("--self-test takes no value");
  const take = (flag: string): string | undefined => {
    const at = args.findIndex(named(flag));
    if (at < 0) return undefined;
    const [arg = ""] = args.splice(at, 1);
    const value = arg === flag ? (args.splice(at, 1)[0] ?? "") : arg.slice(flag.length + 1);
    if (args.some(named(flag))) throw new Error(`${flag} is given twice`);
    return value;
  };
  const device = take("--device");
  // Maestro (2.11) splits a list at commas and drops the blank IDs, so `--device "$A,$B"` with
  // both unset would run as if no device were named.
  if (device?.startsWith("-") || device?.split(",").some((id) => id.trim() === "")) {
    throw new Error("--device takes a simulator's UDID or an emulator's serial");
  }
  const shard = take("--shard");
  if (shard !== undefined) {
    const [i = 0, n = 0] = shard.split("/").map(Number);
    if (!Number.isInteger(i) || !Number.isInteger(n) || i < 1 || i > n) {
      throw new Error(`--shard wants i/n with 1 <= i <= n, not ${shard || "nothing"}`);
    }
    // A flow named runs alone and the shard would be dropped without a word.
    if (args.some((arg) => arg.endsWith(".yaml"))) {
      throw new Error("--shard cuts the whole order; it takes no flow of its own");
    }
  }
  return { global: device === undefined ? [] : ["--device", device], shard, args };
}

/** The command line's cases; copies, boots and runs nothing. */
function selfTest(): never {
  const outcome = (argv: string[]) => {
    try {
      return JSON.stringify(parseArgs(argv));
    } catch (error) {
      return (error as Error).message;
    }
  };
  const udid = "6F0C5E7A-1B2C-4D3E-8F9A-0B1C2D3E4F5A";
  const flow = "apps/mobile/e2e/flows/language.yaml";
  const noShard = "--shard wants i/n with 1 <= i <= n, not nothing";
  const noDevice = "--device takes a simulator's UDID or an emulator's serial";
  const cases: Array<[string[], string]> = [
    [[], `{"global":[],"args":[]}`],
    [
      ["--", "--device", udid, "--shard", "2/4", "--format", "junit"],
      `{"global":["--device","${udid}"],"shard":"2/4","args":["--format","junit"]}`,
    ],
    [
      ["--device=emulator-5554", "--shard=4/4"],
      `{"global":["--device","emulator-5554"],"shard":"4/4","args":[]}`,
    ],
    [[flow], `{"global":[],"args":["${flow}"]}`],
    [["--shard", "2/4", flow], "--shard cuts the whole order; it takes no flow of its own"],
    [["--self-test="], "--self-test takes no value"],
    [["--shard"], noShard],
    [["--shard", "--device", udid], noShard],
    [["--shard="], noShard],
    [["--shard", ""], noShard],
    [["--shard", "--format", "junit"], "--shard wants i/n with 1 <= i <= n, not --format"],
    [["--shard", "5/4"], "--shard wants i/n with 1 <= i <= n, not 5/4"],
    [["--shard", "1/4", "--shard=2/4"], "--shard is given twice"],
    [["--device"], noDevice],
    [["--device", "--shard", "2/4"], noDevice],
    [["--device="], noDevice],
    [["--device", " "], noDevice],
    [["--device", ","], noDevice],
    [["--device", `${udid},`], noDevice],
    [["--device", udid, "--device", "emulator-5554"], "--device is given twice"],
  ];
  const failed = cases.filter(([argv, expected]) => outcome(argv) !== expected);
  for (const [argv, expected] of failed) {
    console.error(`✖ self-test: ${JSON.stringify(argv)} gave ${outcome(argv)}, not ${expected}`);
  }
  // The refusal comes before the copy: the script itself, given a picture cache with a marker in a
  // home of its own and an empty PATH (no simctl, no Maestro), must exit without the marker in media/.
  const home = mkdtempSync(join(tmpdir(), "kuutti-e2e-self-test-"));
  mkdirSync(demoAssetsDir(undefined, home), { recursive: true });
  writeFileSync(join(demoAssetsDir(undefined, home), "self-test.marker"), "");
  const child = spawnSync(process.execPath, [import.meta.filename, "--shard"], {
    env: { HOME: home, PATH: "" },
    encoding: "utf8",
  });
  const copied = existsSync(join(MEDIA, "self-test.marker"));
  rmSync(join(MEDIA, "self-test.marker"), { force: true });
  rmSync(home, { recursive: true, force: true });
  const early = child.status === 1 && child.stderr === `e2e: ${noShard}\n` && !copied;
  if (!early) {
    console.error(
      `✖ self-test: --shard exited ${child.status} (${child.stderr.trim()}), copied ${copied}`,
    );
  }
  if (failed.length > 0 || !early) process.exit(1);
  console.log(`✔ e2e self-test: ${cases.length} command lines, refused before the copy`);
  process.exit(0);
}
