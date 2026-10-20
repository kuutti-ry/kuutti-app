/**
 * e2e: the Maestro flows on a booted simulator (#164, ADR-020).
 *
 *   pnpm e2e                                   every flow under apps/mobile/e2e/flows (config.yaml)
 *   pnpm e2e -- --device <udid>                one simulator, booted for the run and shut down after
 *   pnpm e2e -- apps/mobile/e2e/flows/x.yaml   one flow
 *   pnpm e2e -- --shard 2/4                    the second of four stretches of the order (CI's jobs)
 *   node scripts/e2e.ts --self-test            the command line's and the recovery's cases; runs nothing
 *
 * The flows start from the cast's stories, so `pnpm demo:reset` comes first,
 * and the photo flows take their pictures from the release `pnpm demo:assets`
 * fetched: it is copied to `apps/mobile/e2e/media` (git ignores it), since
 * Maestro's addMedia reads files inside the flows' workspace and does not
 * follow a link out of it. Homebrew's OpenJDK, which Maestro needs, is
 * keg-only, so it is put on the PATH here.
 *
 * chat-live (#349) needs a second phone: its script writes as Ville over
 * HTTP while the flow watches Antti's screen. When it is among the flows to
 * run, Ville signs in here first, at the mock bank on this computer as the
 * demo commands sign in, and the flow is handed the refresh token and the
 * API's address (E2E_API_URL, http://127.0.0.1:3000 unless set).
 *
 * An emulator can drop out of adb in the middle of a run, and every flow after it then fails in
 * milliseconds (#362). Given the emulator's serial (`--device emulator-5554`) and a JUnit report
 * (`--format junit --output <file>`), as CI's jobs give them, the script reads in the report where
 * the device went, waits for adb to see it again, for it to finish booting and for its package
 * manager to answer, keeps the device's log as it came back (`<file>.logcat.txt`), puts back the
 * `adb reverse` forwards it had before the run and runs the flows that failed from there once more,
 * their report beside the first (`<file>.retry.xml`). Each step is a line of the log, the first
 * also a warning on the run's page in GitHub Actions. A flow that failed before stays failed.
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
import { join, relative, resolve } from "node:path";
import { parse, parseAllDocuments, stringify } from "yaml";
// By path: the root is no workspace of @kuutti/db, and this is a command line (the demo tools' rule).
import { loginAs } from "../apps/api/scripts/demo/bank.ts";
import { DEMO_PERSONAS } from "../packages/db/src/seed/personas.ts";
import { demoAssetsDir } from "../packages/db/src/seed/photos.ts";

const ROOT = resolve(import.meta.dirname, "..");
// The workspace: config.yaml there says flows/ is what runs, and common/ and media/ lie inside it.
const WORKSPACE = "apps/mobile/e2e";
const MEDIA = resolve(ROOT, "apps/mobile/e2e/media");

if (process.argv.includes("--self-test")) await selfTest();
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
const plan = single
  ? { config: [], flows: args.filter((arg) => arg.endsWith(".yaml")) }
  : planRun(shard);
const { config } = plan;
const live = plan.flows.some((flow) => flow.endsWith("chat-live.yaml")) ? await liveEnv() : [];
// A simulator named by its UDID is booted if it is not and shut down after the run, passed or
// failed: left booted between runs, one gathered 127 web content processes, some 6 GB, in an
// hour of runs (11/10/2026). An emulator's serial cannot start it again, so Android stays up.
const simulator = global.find((arg) => /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(arg));
if (simulator) spawnSync("xcrun", ["simctl", "bootstatus", simulator, "-b"], { stdio: "inherit" });
const target = single ? [] : [WORKSPACE];
// A second Metro (a worktree's beside the checkout's) is named by its port.
const metro = process.env.METRO_PORT ? ["-e", `METRO_PORT=${process.env.METRO_PORT}`] : [];

// An emulator named by its one serial is waited for when adb loses it mid-run, which the run's
// JUnit report tells (#362); a simulator, a list of devices or a flow named alone run as before.
const [, device = ""] = global;
const report = single ? undefined : reportOf(args);
const emulator =
  report !== undefined && device !== "" && !simulator && !device.includes(",") ? device : undefined;
const forwards = emulator ? forwardsOf(adb(["-s", emulator, "reverse", "--list"]).stdout) : [];

// Off a Mac (CI) there is no Homebrew, and the job puts its own JDK on the PATH.
const brew = spawnSync("brew", ["--prefix", "openjdk"], { encoding: "utf8" });
const jdk = brew.status === 0 ? `${brew.stdout.trim()}/bin:` : "";
const maestro = (order: string[], rest: string[], second: string[]): number =>
  spawnSync("maestro", [...global, "test", ...order, ...metro, ...second, ...rest, ...target], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, PATH: `${jdk}${process.env.PATH ?? ""}` },
  }).status ?? 1;
// A report left by an earlier run must not be read as this one's.
if (emulator !== undefined && report !== undefined) rmSync(resolve(ROOT, report), { force: true });
let status = maestro(config, args, live);
if (status !== 0 && emulator !== undefined && report !== undefined) {
  const workspace = resolve(ROOT, WORKSPACE);
  status = await recover({
    serial: emulator,
    status,
    report,
    forwards,
    read: (path) => {
      const file = resolve(ROOT, path);
      return existsSync(file) ? readFileSync(file, "utf8") : undefined;
    },
    write: (path, text) => writeFileSync(resolve(ROOT, path), text),
    rerun: async (flows, output) => {
      rmSync(resolve(ROOT, output), { force: true });
      // Ville's refresh token turns over at each use and a used one ends the session (the API's
      // identity/sessions.ts), and the first run may have used it: chat-live signs him in anew.
      const second = flows.some((flow) => flow.file.endsWith("chat-live.yaml"))
        ? await liveEnv()
        : [];
      return maestro(
        writeConfig(
          flows.map((flow) => relative(workspace, resolve(ROOT, flow.file))),
          flows.map((flow) => flow.name),
        ),
        withOutput(args, output),
        second,
      );
    },
    adb,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    log: (line) => console.log(line),
    annotate: process.env.GITHUB_ACTIONS === "true",
  });
}
if (simulator) spawnSync("xcrun", ["simctl", "shutdown", simulator], { stdio: "inherit" });
process.exit(status);

/**
 * chat-live's second phone (#349): Ville's session, made through the mock bank
 * as `pnpm demo:reset` makes the personas', handed to Maestro as the refresh
 * token. The flow's script trades it for an access token when it writes, so
 * the fifteen minutes an access token lives never run out first. The bank
 * and the API must be on this computer (`loginAs` refuses anything else).
 */
async function liveEnv(): Promise<string[]> {
  const api = process.env.E2E_API_URL ?? "http://127.0.0.1:3000";
  const ville = DEMO_PERSONAS.find((persona) => persona.key === "ville");
  if (!ville) throw new Error("no persona ville");
  const login = await loginAs(ville, { api, fetch, now: () => new Date() });
  if (login.kind !== "session") {
    console.error(`e2e: chat-live: the bank refused Ville (${login.error}); run pnpm demo:reset`);
    process.exit(1);
  }
  return ["-e", `API_URL=${api}`, "-e", `CHAT_LIVE_REFRESH=${login.refreshToken}`];
}

/**
 * The order of config.yaml held to the flows, and for `--shard i/n` a config of the i-th stretch,
 * passed to Maestro with --config. Maestro knows a flow in the order by its name and cuts the
 * sequence short at a name it cannot find, without a word, so a flow left out, a name no flow has
 * and a name twice are refused here. A stretch is cut where the running weight passes i/n of the
 * whole, so a persona's flows stay on one device as far as the cut allows (#226).
 */
function planRun(shard: string | undefined): { config: string[]; flows: string[] } {
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
  if (shard === undefined) {
    return { config: [], flows: order.map((name) => `flows/${flows.get(name)?.file}`) };
  }

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
  const flowsOf = part.map((name) => `flows/${flows.get(name)?.file}`);
  const config = writeConfig(flowsOf, part);
  console.log(
    `e2e: shard ${shard}, ${part.length} of ${order.length} flows: ${flowsOf.join(", ")}`,
  );
  return { config, flows: flowsOf };
}

/**
 * A config for --config that runs these flows (paths inside the workspace) in this order (their
 * names), each whatever the one before did: a shard's stretch (#226) or the flows run again (#362).
 */
function writeConfig(flows: string[], names: string[]): string[] {
  const file = join(mkdtempSync(join(tmpdir(), "kuutti-e2e-")), "config.yaml");
  writeFileSync(
    file,
    stringify(
      { flows, executionOrder: { continueOnFailure: true, flowsOrder: names } },
      { lineWidth: 0 },
    ),
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

/** A flag as `--flag value` or `--flag=value`. */
function named(flag: string): (arg: string) => boolean {
  return (arg) => arg === flag || arg.startsWith(`${flag}=`);
}

/** A flag's value among Maestro's arguments, read and left in place. */
function flagValue(args: string[], flag: string): string | undefined {
  const at = args.findIndex(named(flag));
  if (at < 0) return undefined;
  return args[at] === flag ? args[at + 1] : args[at]?.slice(flag.length + 1);
}

/** The JUnit report Maestro is asked to write, if it is: what tells a lost device (#362). */
function reportOf(args: string[]): string | undefined {
  return flagValue(args, "--format")?.toLowerCase() === "junit"
    ? flagValue(args, "--output")
    : undefined;
}

/** Maestro's arguments with the report written elsewhere: the second run's beside the first's. */
function withOutput(args: string[], output: string): string[] {
  const at = args.findIndex(named("--output"));
  return args.map((arg, i) =>
    i === at && arg !== "--output"
      ? `--output=${output}`
      : i === at + 1 && args[at] === "--output"
        ? output
        : arg,
  );
}

/** A flow as Maestro's JUnit report (2.11) has it: a testcase in the order run, its time in seconds. */
interface FlowResult {
  name: string;
  /** From the repository's root, as Maestro was started there. */
  file: string;
  seconds: number;
  /** The failure's text; none when the flow passed. */
  failure?: string;
}

/** The report's testcases. Nothing to read (no report, or not Maestro's) is no flows. */
function readReport(xml: string): FlowResult[] {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  const text = (raw: string) =>
    raw.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => entities[entity] ?? "");
  // shortcut: Maestro 2.11's report read with patterns, not an XML parser (no new dependency); a
  // report of another shape yields no flows, and the run stays failed as before the recovery.
  // An attribute's value may hold a slash or a >, so quoted values are taken whole.
  const testcases = xml.matchAll(
    /<testcase\b((?:[^>"/]|"[^"]*")*)(?:\/>|>([\s\S]*?)<\/testcase>)/g,
  );
  return [...testcases].map(([, attributes = "", body = ""]) => {
    const attribute = (key: string) =>
      text(new RegExp(`(?:^|\\s)${key}="([^"]*)"`).exec(attributes)?.[1] ?? "");
    const failure = /<failure\b[^>]*?(?:\/>|>([\s\S]*?)<\/failure>)/.exec(body);
    return {
      name: attribute("name"),
      file: attribute("file"),
      // parseFloat, not Number: a missing time is no time, not a flow that took none.
      seconds: Number.parseFloat(attribute("time")),
      ...(failure ? { failure: text(failure[1] ?? "") } : {}),
    };
  });
}

/** The words of a failure that names the device going, in Maestro's words or adb's. */
function deviceGone(failure: string): string | undefined {
  return /device offline|device '[^']*' not found|DeviceServerDiedException/.exec(failure)?.[0];
}

/**
 * Where the device was lost: the first flow that failed in under a second, which no flow does that
 * reaches the app (opening it alone takes longer), or whose failure names the device going (#362).
 * Every flow after it failed in milliseconds in the three runs that lost theirs.
 */
function lostAt(flows: FlowResult[]): number | undefined {
  const at = flows.findIndex(
    (flow) =>
      flow.failure !== undefined && (flow.seconds < 1 || deviceGone(flow.failure) !== undefined),
  );
  return at < 0 ? undefined : at;
}

/** `adb reverse --list`: a line per forward, its connection's name, the device's end, the host's. */
function forwardsOf(list: string): Array<[string, string]> {
  return list.split("\n").flatMap((line) => {
    const words = line.trim().split(/\s+/);
    const [remote = "", local = ""] = words.slice(-2);
    return words.length >= 2 && remote.includes(":") && local.includes(":")
      ? [[remote, local] as [string, string]]
      : [];
  });
}

interface AdbResult {
  /** null when it ran out of time. */
  status: number | null;
  stdout: string;
}

/** adb with a time limit; a whole device log fits in what it may print. */
function adb(argv: string[], timeout = 10_000): AdbResult {
  const done = spawnSync("adb", argv, { encoding: "utf8", timeout, maxBuffer: 256 * 1024 * 1024 });
  return { status: done.status, stdout: done.stdout ?? "" };
}

/** A recovery's run and its ways to the world, which the self-test fakes. */
interface Recovery {
  serial: string;
  /** The first run's exit status, not 0. */
  status: number;
  /** The first run's JUnit report; the second's and the device's log go beside it. */
  report: string;
  /** The `adb reverse` forwards before the run, as [the device's end, the host's]. */
  forwards: Array<[string, string]>;
  read: (path: string) => string | undefined;
  write: (path: string, text: string) => void;
  /** Maestro over these flows in this order, writing that report; its exit status. */
  rerun: (flows: FlowResult[], report: string) => number | Promise<number>;
  adb: (argv: string[], timeout: number) => AdbResult;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /** In GitHub Actions: the first line is a warning on the run's page as well. */
  annotate: boolean;
}

/**
 * After a failed run on an emulator (#362): when the report shows the device lost, wait for it,
 * keep its log, put the forwards back and run the flows that failed from there once, never more.
 * The answer is the run's exit status: the second run's, unless a flow failed before the loss.
 */
async function recover(r: Recovery): Promise<number> {
  const flows = readReport(r.read(r.report) ?? "");
  const at = lostAt(flows);
  const lost = at === undefined ? undefined : flows[at];
  if (at === undefined || lost === undefined) return r.status;
  const before = flows.slice(0, at).filter((flow) => flow.failure !== undefined);
  const again = flows.slice(at).filter((flow) => flow.failure !== undefined);
  const how =
    lost.seconds < 1
      ? `which failed in ${Math.round(lost.seconds * 1000)} ms`
      : `whose failure says ${deviceGone(lost.failure ?? "")}`;
  r.log(
    `${r.annotate ? "::warning::" : ""}e2e: ${r.serial} dropped out of adb at "${lost.name}", ${how}; waiting for it to come back, then the flows that failed from there run once more (#362)`,
  );
  const device = (argv: string[], timeout = 10_000) => r.adb(["-s", r.serial, ...argv], timeout);
  const stop = (why: string) => {
    r.log(`e2e: ${why}; the run stays failed`);
    return r.status;
  };
  const until = async (argv: string[], ok: (stdout: string) => boolean, tries: number) => {
    for (let i = 0; i < tries; i += 1) {
      if (i > 0) await r.sleep(2_000);
      if (ok(device(argv).stdout)) return true;
    }
    return false;
  };

  // adb tries a dropped emulator's port 60 times a second apart and then forgets it, until a
  // server starts and scans the emulators' ports again (client/transport_emulator.cpp in adb's
  // source): so one restart of the server, when waiting fails.
  if (device(["wait-for-device"], 120_000).status !== 0) {
    r.log(
      `e2e: ${r.serial} is not back after 2 minutes; restarting adb's server, which looks for emulators as it starts`,
    );
    r.adb(["kill-server"], 10_000);
    r.adb(["start-server"], 30_000);
    if (device(["wait-for-device"], 180_000).status !== 0) {
      return stop(`${r.serial} did not come back`);
    }
  }
  r.log(`e2e: ${r.serial} is connected again`);
  if (
    !(await until(["shell", "getprop", "sys.boot_completed"], (out) => out.trim() === "1", 150))
  ) {
    return stop(`${r.serial} did not finish booting within 5 minutes`);
  }
  r.log(`e2e: ${r.serial} has finished booting`);
  // Booted is not yet ready: Maestro installs its driver as it starts, and an install fails until
  // the package manager answers (#355).
  if (!(await until(["shell", "pm", "path", "android"], (out) => /^package:/m.test(out), 60))) {
    return stop(`${r.serial}'s package manager did not answer within 2 minutes`);
  }
  r.log(`e2e: ${r.serial}'s package manager answers`);
  // The guest's own account of the loss, before the second run fills the buffer; a log that
  // begins at a boot says the guest restarted.
  const logcat = r.report.replace(/(\.xml)?$/, ".logcat.txt");
  r.write(logcat, device(["logcat", "-d", "-b", "all"], 60_000).stdout);
  r.log(`e2e: the device's log as it came back is in ${logcat}`);
  const kept = new Set(
    forwardsOf(device(["reverse", "--list"]).stdout).map((pair) => pair.join(" ")),
  );
  for (const [remote, local] of r.forwards) {
    if (kept.has(`${remote} ${local}`)) continue;
    if (device(["reverse", remote, local]).status !== 0) {
      return stop(`the forward of ${remote} could not be put back`);
    }
    r.log(`e2e: the forward of ${remote} had gone with the device; put back`);
  }

  const retry = r.report.replace(/(\.xml)?$/, ".retry$1");
  r.log(`e2e: running once more: ${again.map((flow) => flow.file.split("/").pop()).join(", ")}`);
  const status = await r.rerun(again, retry);
  if (status === 0) {
    r.log(`e2e: the second run passed; its report is ${retry}`);
  } else {
    const lostAgain = lostAt(readReport(r.read(retry) ?? "")) !== undefined;
    r.log(
      `e2e: the second run failed${lostAgain ? `, ${r.serial} dropped out again` : ""}; there is no third (${retry})`,
    );
  }
  if (before.length === 0) return status;
  r.log(
    `e2e: what had failed before ${r.serial} dropped out stays failed: ${before.map((flow) => flow.name).join("; ")}`,
  );
  return r.status;
}

/**
 * --device and --shard are this script's, as `--shard 2/4` or `--shard=2/4`; the rest is Maestro's
 * (flows, --format, -e). A flag without a usable value is refused before anything is copied or
 * booted, never read as no flag: `--shard` last, or before --device, ran every flow (#235).
 */
function parseArgs(argv: string[]): { global: string[]; shard?: string; args: string[] } {
  const args = argv.filter((arg) => arg !== "--");
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

/** The command line's cases and the recovery's; copies, boots and runs nothing. */
async function selfTest(): Promise<never> {
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
  const recovery = await recoveryChecks();
  for (const problem of recovery.failures) console.error(`✖ self-test: ${problem}`);
  if (failed.length > 0 || !early || recovery.failures.length > 0) process.exit(1);
  console.log(
    `✔ e2e self-test: ${cases.length} command lines, refused before the copy; ${recovery.checks} checks of the recovery`,
  );
  process.exit(0);
}

/**
 * The recovery (#362): what the report tells, and what is done about it against a fake adb whose
 * waits answer at once and a fake Maestro, so nothing sleeps and no device is needed.
 */
async function recoveryChecks(): Promise<{ checks: number; failures: string[] }> {
  const failures: string[] = [];
  let checks = 0;
  const expect = (what: string, got: unknown, want: unknown) => {
    checks += 1;
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`${what}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
    }
  };

  // Maestro's report as run 39138046538 wrote it, shortened: a pass, the flow cut off as the device
  // went, one after it that failed in milliseconds (with the escapes a name may carry), and one
  // without a time.
  const report = `<?xml version='1.0' encoding='UTF-8'?>
<testsuites>
  <testsuite name="Test Suite" device="e2e" tests="4" failures="3" time="182.5" timestamp="2026-10-18T14:57:44">
    <testcase id="A photo opens full size" name="A photo opens full size" classname="A photo opens full size" file="apps/mobile/e2e/flows/photos-screen.yaml" time="57.434" timestamp="2026-10-18T15:00:56" status="SUCCESS"/>
    <testcase id="Fill in the rest" name="Fill in the rest" classname="Fill in the rest" file="apps/mobile/e2e/flows/later-fields-ask-later.yaml" time="24.132" timestamp="2026-10-18T15:01:53" status="ERROR">
      <failure>maestro.android.DeviceServerDiedException: Device server died during 'viewHierarchy' on emulator-5554 (700ms since last byte, connection age 280444ms): StatusRuntimeException: UNAVAILABLE: End of stream or IOException
	at maestro.android.AndroidDeviceConnection.onGrpcDeath(AndroidDeviceConnection.kt:319)
</failure>
    </testcase>
    <testcase id="Taking one's own answer back" name="Taking one's own answer back &amp; &lt;a&gt; &quot;b&quot;" classname="Taking one's own answer back" file="apps/mobile/e2e/flows/deal-breaker-paused.yaml" time="0.026" timestamp="2026-10-18T15:02:17" status="ERROR">
      <failure>Unknown error</failure>
    </testcase>
    <testcase name="No time" file="apps/mobile/e2e/flows/no-time.yaml" status="ERROR"><failure/></testcase>
  </testsuite>
</testsuites>
`;
  const summary = (flows: FlowResult[]) =>
    flows.map((flow) => [flow.name, flow.file, flow.seconds, flow.failure?.split("\n")[0] ?? null]);
  expect("the report", summary(readReport(report)), [
    ["A photo opens full size", "apps/mobile/e2e/flows/photos-screen.yaml", 57.434, null],
    [
      "Fill in the rest",
      "apps/mobile/e2e/flows/later-fields-ask-later.yaml",
      24.132,
      "maestro.android.DeviceServerDiedException: Device server died during 'viewHierarchy' on emulator-5554 (700ms since last byte, connection age 280444ms): StatusRuntimeException: UNAVAILABLE: End of stream or IOException",
    ],
    [
      `Taking one's own answer back & <a> "b"`,
      "apps/mobile/e2e/flows/deal-breaker-paused.yaml",
      0.026,
      "Unknown error",
    ],
    // JSON has no NaN: the missing time reads as null here.
    ["No time", "apps/mobile/e2e/flows/no-time.yaml", null, ""],
  ]);
  expect("the report's loss", lostAt(readReport(report)), 1);
  expect("no report", readReport(""), []);
  expect("a report of nothing", readReport("<testsuites/>"), []);

  const flow = (name: string, seconds: number, failure?: string): FlowResult => ({
    name,
    file: `apps/mobile/e2e/flows/${name}.yaml`,
    seconds,
    ...(failure === undefined ? {} : { failure }),
  });
  const pass = (name: string) => flow(name, 60);
  const slow = (name: string) => flow(name, 70, 'Assertion is false: "Your card" is visible');
  const fast = (name: string) => flow(name, 0.03, "Unknown error");
  const cut = (name: string) =>
    flow(
      name,
      24,
      "maestro.android.DeviceServerDiedException: Device server died during 'viewHierarchy'",
    );
  expect("nothing ran", lostAt([]), undefined);
  expect("every flow passed", lostAt([pass("a"), pass("b")]), undefined);
  expect("a flow failed by itself", lostAt([pass("a"), slow("b"), pass("c")]), undefined);
  expect("lost between flows", lostAt([pass("a"), pass("b"), fast("c"), fast("d")]), 2);
  expect("lost within a flow", lostAt([pass("a"), cut("b"), fast("c")]), 1);
  expect(
    "adb's offline",
    lostAt([flow("a", 30, "host:transport:emulator-5554): device offline")]),
    0,
  );
  expect("adb's not found", lostAt([flow("a", 30, "device 'emulator-5554' not found")]), 0);
  expect("a second is not fast", lostAt([flow("a", 1, "Unknown error")]), undefined);
  expect("lost after a failure", lostAt([slow("a"), pass("b"), fast("c")]), 2);

  expect("junit", reportOf(["--format", "junit", "--output", "e2e-report.xml"]), "e2e-report.xml");
  expect("junit=", reportOf(["--format=JUNIT", "--output=out/r.xml"]), "out/r.xml");
  expect("html", reportOf(["--format", "html", "--output", "r.html"]), undefined);
  expect("junit, no output", reportOf(["--format", "junit"]), undefined);
  expect("output, no format", reportOf(["--output", "r.xml"]), undefined);
  expect(
    "the second report",
    withOutput(
      ["--format", "junit", "--output", "e2e-report.xml", "-e", "A=1"],
      "e2e-report.retry.xml",
    ),
    ["--format", "junit", "--output", "e2e-report.retry.xml", "-e", "A=1"],
  );
  expect("the second report=", withOutput(["--output=a.xml", "--format=junit"], "b.xml"), [
    "--output=b.xml",
    "--format=junit",
  ]);
  expect("forwards", forwardsOf("host-19 tcp:3000 tcp:3000\r\nhost-19 tcp:8081 tcp:8081\n\n"), [
    ["tcp:3000", "tcp:3000"],
    ["tcp:8081", "tcp:8081"],
  ]);
  expect("no forwards", forwardsOf(""), []);
  expect("no device", forwardsOf("error: no devices/emulators found\n"), []);

  // The world a recovery sees: the first run's report (and the second's), and an emulator that is
  // healthy unless an answer says otherwise; 8080's forward survived, 3000's and 8081's went.
  const xmlText = (raw: string) =>
    raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const junit = (flows: FlowResult[]) =>
    `<testsuites><testsuite name="Test Suite">${flows
      .map((f) => {
        const head = `<testcase name="${xmlText(f.name)}" file="${f.file}" time="${f.seconds}"`;
        return f.failure === undefined
          ? `${head} status="SUCCESS"/>`
          : `${head} status="ERROR"><failure>${xmlText(f.failure)}</failure></testcase>`;
      })
      .join("")}</testsuite></testsuites>`;
  const healthy: Record<string, AdbResult> = {
    "shell getprop sys.boot_completed": { status: 0, stdout: "1\r\n" },
    "shell pm path android": {
      status: 0,
      stdout: "package:/system/framework/framework-res.apk\r\n",
    },
    "logcat -d -b all": { status: 0, stdout: "--------- beginning of main\n" },
    "reverse --list": { status: 0, stdout: "host-19 tcp:8080 tcp:8080\n" },
  };
  const world = async (setup: {
    first?: FlowResult[];
    second?: FlowResult[];
    rerun?: number;
    answers?: Record<string, AdbResult[]>;
    annotate?: boolean;
  }) => {
    const seen = {
      adb: [] as string[],
      slept: [] as number[],
      lines: [] as string[],
      reran: [] as Array<[string[], string]>,
      written: [] as string[],
    };
    const reports: Record<string, string | undefined> = {
      "e2e-report.xml": setup.first && junit(setup.first),
      "e2e-report.retry.xml": setup.second && junit(setup.second),
    };
    const status = await recover({
      serial: "emulator-5554",
      status: 1,
      report: "e2e-report.xml",
      forwards: [
        ["tcp:3000", "tcp:3000"],
        ["tcp:8080", "tcp:8080"],
        ["tcp:8081", "tcp:8081"],
      ],
      read: (path) => reports[path],
      write: (path, text) => seen.written.push(`${path}: ${text.trim()}`),
      rerun: (flows, output) => {
        seen.reran.push([flows.map((f) => f.name), output]);
        return setup.rerun ?? 0;
      },
      adb: (argv) => {
        seen.adb.push(argv.join(" "));
        const key = (argv[0] === "-s" ? argv.slice(2) : argv).join(" ");
        return setup.answers?.[key]?.shift() ?? healthy[key] ?? { status: 0, stdout: "" };
      },
      sleep: async (ms) => {
        seen.slept.push(ms);
      },
      log: (line) => seen.lines.push(line),
      annotate: setup.annotate ?? true,
    });
    return { status, ...seen };
  };
  const timedOut = { status: null, stdout: "" };
  const on = (command: string) => `-s emulator-5554 ${command}`;

  const own = await world({ first: [pass("a"), slow("b")] });
  expect("a failure of its own: the status", own.status, 1);
  expect("a failure of its own: nothing done", [own.adb, own.reran, own.lines], [[], [], []]);
  const none = await world({});
  expect("no report: nothing done", [none.status, none.adb, none.reran], [1, [], []]);

  const back = await world({
    first: [pass("a"), cut("b"), fast("c"), fast("d")],
    answers: {
      "shell getprop sys.boot_completed": [
        { status: 1, stdout: "" },
        { status: 0, stdout: "0\n" },
      ],
    },
  });
  expect("back: the status is the second run's", back.status, 0);
  expect("back: adb", back.adb, [
    on("wait-for-device"),
    on("shell getprop sys.boot_completed"),
    on("shell getprop sys.boot_completed"),
    on("shell getprop sys.boot_completed"),
    on("shell pm path android"),
    on("logcat -d -b all"),
    on("reverse --list"),
    on("reverse tcp:3000 tcp:3000"),
    on("reverse tcp:8081 tcp:8081"),
  ]);
  expect("back: slept between asking", back.slept, [2000, 2000]);
  expect("back: the device's log kept", back.written, [
    "e2e-report.logcat.txt: --------- beginning of main",
  ]);
  expect("back: from the loss, once", back.reran, [[["b", "c", "d"], "e2e-report.retry.xml"]]);
  expect("back: the log", back.lines, [
    `::warning::e2e: emulator-5554 dropped out of adb at "b", whose failure says DeviceServerDiedException; waiting for it to come back, then the flows that failed from there run once more (#362)`,
    "e2e: emulator-5554 is connected again",
    "e2e: emulator-5554 has finished booting",
    "e2e: emulator-5554's package manager answers",
    "e2e: the device's log as it came back is in e2e-report.logcat.txt",
    "e2e: the forward of tcp:3000 had gone with the device; put back",
    "e2e: the forward of tcp:8081 had gone with the device; put back",
    "e2e: running once more: b.yaml, c.yaml, d.yaml",
    "e2e: the second run passed; its report is e2e-report.retry.xml",
  ]);

  const between = await world({ first: [pass("a"), fast("b"), fast("c")], annotate: false });
  expect(
    "between flows: the first line",
    between.lines[0],
    `e2e: emulator-5554 dropped out of adb at "b", which failed in 30 ms; waiting for it to come back, then the flows that failed from there run once more (#362)`,
  );
  expect("between flows: run again", between.reran, [[["b", "c"], "e2e-report.retry.xml"]]);

  const again = await world({ first: [pass("a"), fast("b")], second: [fast("b")], rerun: 1 });
  expect("lost again: the status", again.status, 1);
  expect("lost again: run once more, not twice", again.reran.length, 1);
  expect(
    "lost again: waited once",
    again.adb.filter((line) => line.endsWith("wait-for-device")).length,
    1,
  );
  expect(
    "lost again: said so",
    again.lines.at(-1),
    "e2e: the second run failed, emulator-5554 dropped out again; there is no third (e2e-report.retry.xml)",
  );

  const failsAgain = await world({ first: [pass("a"), fast("b")], second: [slow("b")], rerun: 1 });
  expect("fails again: the status", failsAgain.status, 1);
  expect(
    "fails again: said so",
    failsAgain.lines.at(-1),
    "e2e: the second run failed; there is no third (e2e-report.retry.xml)",
  );

  const earlier = await world({ first: [slow("a"), slow("b"), pass("c"), fast("d")] });
  expect("failed before the loss: the status stays the first run's", earlier.status, 1);
  expect("failed before the loss: not run again", earlier.reran, [[["d"], "e2e-report.retry.xml"]]);
  expect(
    "failed before the loss: said so",
    earlier.lines.at(-1),
    "e2e: what had failed before emulator-5554 dropped out stays failed: a; b",
  );

  const restart = await world({
    first: [fast("a")],
    answers: { "wait-for-device": [timedOut] },
  });
  expect("back after adb's server restarts: the status", restart.status, 0);
  expect("back after adb's server restarts: adb", restart.adb.slice(0, 5), [
    on("wait-for-device"),
    "kill-server",
    "start-server",
    on("wait-for-device"),
    on("shell getprop sys.boot_completed"),
  ]);
  expect(
    "back after adb's server restarts: said so",
    restart.lines[1],
    "e2e: emulator-5554 is not back after 2 minutes; restarting adb's server, which looks for emulators as it starts",
  );

  const gone = await world({
    first: [fast("a")],
    answers: { "wait-for-device": [timedOut, timedOut] },
  });
  expect("never back: the status", gone.status, 1);
  expect("never back: nothing run", [gone.reran, gone.written], [[], []]);
  expect("never back: adb", gone.adb, [
    on("wait-for-device"),
    "kill-server",
    "start-server",
    on("wait-for-device"),
  ]);
  expect(
    "never back: said so",
    gone.lines.at(-1),
    "e2e: emulator-5554 did not come back; the run stays failed",
  );

  const booting = await world({
    first: [fast("a")],
    answers: {
      "shell getprop sys.boot_completed": Array.from({ length: 150 }, () => ({
        status: 0,
        stdout: "0\n",
      })),
    },
  });
  expect("never booted: the status", booting.status, 1);
  expect(
    "never booted: asked 150 times, 2 s apart",
    [booting.adb.length, booting.slept.length, booting.slept[0]],
    [151, 149, 2000],
  );
  expect(
    "never booted: said so",
    [booting.reran, booting.lines.at(-1)],
    [[], "e2e: emulator-5554 did not finish booting within 5 minutes; the run stays failed"],
  );

  const silent = await world({
    first: [fast("a")],
    answers: {
      "shell pm path android": Array.from({ length: 60 }, () => ({ status: 0, stdout: "" })),
    },
  });
  expect("no package manager: the status", silent.status, 1);
  expect("no package manager: asked 60 times", silent.slept.length, 59);
  expect(
    "no package manager: said so",
    [silent.reran, silent.lines.at(-1)],
    [
      [],
      "e2e: emulator-5554's package manager did not answer within 2 minutes; the run stays failed",
    ],
  );

  const stuck = await world({
    first: [fast("a")],
    answers: { "reverse tcp:3000 tcp:3000": [{ status: 1, stdout: "" }] },
  });
  expect("a forward refused: the status", stuck.status, 1);
  expect(
    "a forward refused: said so",
    [stuck.reran, stuck.lines.at(-1)],
    [[], "e2e: the forward of tcp:3000 could not be put back; the run stays failed"],
  );

  return { checks, failures };
}
