/**
 * dev-env: the whole local environment with one command.
 *
 *   pnpm env:up [--skip api,mobile,admin] [--no-seed]   start everything, Ctrl+C stops the apps
 *   pnpm env:down                                       stop the apps and the database
 *   pnpm env:status                                     who holds which port, database state
 *   node scripts/dev-env.ts --self-test                 the command line's cases; starts nothing
 *
 * What `up` does, in order:
 *   1. Database: `docker compose up -d --wait` when a compose file exists and
 *      Docker is installed (#5); otherwise Homebrew PostgreSQL, started for the
 *      session with pg_ctl, with the kuutti role and databases created if missing.
 *   2. Ports: a port held by a stale copy of one of our own processes (its
 *      working directory is inside this repository) is freed; a port held by
 *      anything else is a hard stop with the owner named. Nothing foreign is
 *      ever killed.
 *   3. Migrate and seed (both idempotent), so every app starts against a
 *      current, populated database.
 *   4. API (3000), Metro for the app and its web target (8081), admin (5173),
 *      each in its own process group with prefixed output, readiness-checked.
 *
 * Runs with `node --env-file-if-exists=.env`: the runtime reads .env, this
 * script never opens it (rule 9). DATABASE_URL falls back to the local
 * default, which is not a secret. No dependencies. Node 22.18+.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { parseArgs as parseOptions } from "node:util";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_DATABASE_URL = "postgres://kuutti:kuutti@127.0.0.1:5432/kuutti";
const DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

type Service = {
  name: string;
  color: string;
  port: number;
  readyUrl: string;
  dir: string;
  script: string;
  extraArgs?: string[];
  env?: Record<string, string>;
};

const SERVICES: Service[] = [
  {
    name: "api",
    color: "36",
    port: 3000,
    readyUrl: "http://localhost:3000/health",
    dir: "apps/api",
    script: "dev",
  },
  {
    name: "mobile",
    color: "35",
    port: 8081,
    readyUrl: "http://localhost:8081/",
    dir: "apps/mobile",
    script: "start",
    extraArgs: ["--port", "8081"],
    env: { EXPO_NO_TELEMETRY: "1" },
  },
  {
    name: "admin",
    color: "33",
    port: 5173,
    readyUrl: "http://localhost:5173/",
    dir: "apps/admin",
    script: "dev",
    extraArgs: ["--port", "5173", "--strictPort"],
  },
];

const OURS = /(node|pnpm|npm|npx|tsx|expo|vite|metro)/i;
const WRAPPER_SHELL = /^(\/bin\/)?(sh|bash|zsh) -c /;
const SHELLS = /(^|\/)(-?zsh|-?bash|-?sh|fish|login|Terminal|iTerm|WebStorm|code)(\s|$)/i;

// ---------------------------------------------------------------- output

function paint(color: string, text: string): string {
  return process.stdout.isTTY ? `\x1b[${color}m${text}\x1b[0m` : text;
}
function log(tag: string, color: string, line: string): void {
  process.stdout.write(`${paint(color, `[${tag}]`)} ${line}\n`);
}
const env = (line: string) => log("env", "34", line);
function fail(line: string): never {
  log("env", "31", line);
  killChildrenNow();
  process.exit(1);
}

// ---------------------------------------------------------------- processes

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; detached?: boolean } = {},
) {
  return new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: opts.detached ?? false,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString();
    });
    child.on("error", (e) => done({ code: null, out, err: `${err}${e.message}` }));
    child.on("close", (code) => done({ code, out, err }));
  });
}

async function streamed(
  tag: string,
  color: string,
  cmd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  dir = ".",
) {
  const cwd = resolve(ROOT, dir);
  const child = spawn(cmd, args, {
    cwd,
    env: {
      ...process.env,
      PATH: `${cwd}/node_modules/.bin:${ROOT}/node_modules/.bin:${process.env.PATH ?? ""}`,
      FORCE_COLOR: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  pipe(child, tag, color);
  const code = await new Promise<number | null>((done) => child.on("close", done));
  if (code !== 0) fail(`${tag} exited with ${code}`);
}

function pipe(child: ChildProcess, tag: string, color: string): void {
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = "";
    stream?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim() !== "") log(tag, color, line);
    });
  }
}

type Owner = { pid: number; command: string; cwd: string; ours: boolean };

async function listeners(port: number): Promise<Owner[]> {
  const { out } = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  const pids = [...new Set(out.split(/\s+/).filter(Boolean).map(Number))];
  const owners: Owner[] = [];
  for (const pid of pids) {
    const command = (await run("ps", ["-o", "command=", "-p", String(pid)])).out.trim();
    const cwdOut = (await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])).out;
    const cwd =
      cwdOut
        .split("\n")
        .find((l) => l.startsWith("n"))
        ?.slice(1) ?? "";
    owners.push({
      pid,
      command,
      cwd,
      ours: cwd.startsWith(ROOT) && (OURS.test(command) || WRAPPER_SHELL.test(command)),
    });
  }
  return owners;
}

/** The listener plus its supervisors (pnpm, node --watch) up to, never including, a shell. */
async function processTree(pid: number): Promise<number[]> {
  const chain = [pid];
  let current = pid;
  for (let i = 0; i < 6; i += 1) {
    const ppid = Number((await run("ps", ["-o", "ppid=", "-p", String(current)])).out.trim());
    if (!ppid || ppid <= 1) break;
    const command = (await run("ps", ["-o", "command=", "-p", String(ppid)])).out.trim();
    const wrapper = WRAPPER_SHELL.test(command);
    if (!wrapper && (!OURS.test(command) || SHELLS.test(command))) break;
    chain.push(ppid);
    current = ppid;
  }
  return chain;
}

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort(service: Pick<Service, "name" | "port">): Promise<void> {
  const owners = await listeners(service.port);
  if (owners.length === 0) return;
  for (const owner of owners) {
    if (!owner.ours) {
      fail(
        `port ${service.port} (${service.name}) is held by pid ${owner.pid}, not ours: ${owner.command}\n` +
          `      working directory ${owner.cwd || "unknown"}. Stop it yourself or change the port; nothing foreign is killed.`,
      );
    }
    const tree = await processTree(owner.pid);
    env(
      `port ${service.port} (${service.name}) held by a stale copy of ours, stopping pid ${tree.join(" < ")}`,
    );
    for (const pid of tree.reverse()) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await Promise.all(tree.map(alive))).some(Boolean)) {
      await sleep(200);
    }
    for (const pid of tree) if (await alive(pid)) process.kill(pid, "SIGKILL");
  }
  const still = await listeners(service.port);
  if (still.length > 0)
    fail(
      `port ${service.port} is still busy after stopping pid ${still.map((o) => o.pid).join(", ")}`,
    );
}

// ---------------------------------------------------------------- database

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
    socket.setTimeout(1_000, () => {
      socket.destroy();
      done(false);
    });
  });
}

async function waitFor(
  what: string,
  probe: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await sleep(500);
  }
  fail(`${what} did not come up within ${Math.round(timeoutMs / 1000)} s`);
}

const composeFile = ["docker-compose.yml", "compose.yml", "docker-compose.yaml", "compose.yaml"]
  .map((f) => resolve(ROOT, f))
  .find(existsSync);

async function hasDocker(): Promise<boolean> {
  return (
    (await run("docker", ["compose", "version"])).code === 0 &&
    (await run("docker", ["info"])).code === 0
  );
}

/** Is the listener on the database port our compose container? */
async function composeHasPostgres(): Promise<boolean> {
  if (!composeFile) return false;
  const ps = await run("docker", ["compose", "ps", "--status", "running", "-q", "postgres"]);
  return ps.code === 0 && ps.out.trim().length > 0;
}

function brewPostgres(): { pgCtl: string; psql: string; dataDir: string } | null {
  for (const version of ["17", "18", "16"]) {
    const bin = `/opt/homebrew/opt/postgresql@${version}/bin`;
    if (existsSync(`${bin}/pg_ctl`)) {
      return {
        pgCtl: `${bin}/pg_ctl`,
        psql: `${bin}/psql`,
        dataDir: `/opt/homebrew/var/postgresql@${version}`,
      };
    }
  }
  return null;
}

async function ensureDatabase(): Promise<void> {
  const url = new URL(DATABASE_URL);
  const host = url.hostname;
  const port = Number(url.port || 5432);

  const docker = composeFile ? await hasDocker() : false;
  const brewListening = (await portOpen(host, port)) && !(await composeHasPostgres());

  if (docker && brewListening && brewPostgres()) {
    // Docker arrived after Homebrew PostgreSQL was the fallback: hand the port over.
    const brew = brewPostgres() as NonNullable<ReturnType<typeof brewPostgres>>;
    env("Homebrew PostgreSQL holds the port; stopping it so the compose stack can take over");
    await run(brew.pgCtl, ["-D", brew.dataDir, "stop", "-m", "fast"]);
    await waitFor("port release", async () => !(await portOpen(host, port)), 15_000);
  }

  if (await portOpen(host, port)) {
    env(`database already listening on ${host}:${port}`);
  } else if (docker) {
    env(`starting docker compose (${composeFile})`);
    // The S3 stand-in creates the media bucket itself at start (docker-compose.yml).
    await streamed("db", "32", "docker", ["compose", "up", "-d", "--wait", "--quiet-pull"]);
    await waitFor("postgres", () => portOpen(host, port), 60_000);
  } else {
    if (composeFile)
      env(
        "docker compose not available: falling back to Homebrew PostgreSQL; the S3 stand-in and the mock IdP stay down (pnpm env:doctor)",
      );
    const brew = brewPostgres();
    if (!brew) {
      fail(
        "no database: install Docker Desktop or OrbStack for docker compose (#5), or `brew install postgresql@17`",
      );
    }
    env(`starting Homebrew PostgreSQL from ${brew.dataDir}`);
    // Own session (detached): the postmaster must outlive this process and must
    // not sit in the terminal's foreground group, or Ctrl+C would stop it too.
    const started = await run(
      brew.pgCtl,
      ["-D", brew.dataDir, "-l", `${brew.dataDir}/server.log`, "-o", `-p ${port} -k /tmp`, "start"],
      { env: { LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" }, detached: true },
    );
    if (started.code !== 0) fail(`pg_ctl start failed:\n${started.out}${started.err}`);
    await waitFor("postgres", () => portOpen(host, port), 30_000);
  }

  // Role and databases for the local default; a custom DATABASE_URL is the caller's business.
  if (DATABASE_URL === DEFAULT_DATABASE_URL) {
    const brew = brewPostgres();
    if (brew && !composeFile) {
      const psql = (sql: string, db = "postgres") =>
        run(brew.psql, [
          "-h",
          host,
          "-p",
          String(port),
          "-d",
          db,
          "-v",
          "ON_ERROR_STOP=1",
          "-tAc",
          sql,
        ]);
      await psql(
        "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kuutti') THEN CREATE ROLE kuutti LOGIN PASSWORD 'kuutti' CREATEDB; END IF; END $$;",
      );
      for (const db of ["kuutti", "kuutti_test"]) {
        const exists =
          (await psql(`SELECT 1 FROM pg_database WHERE datname = '${db}'`)).out.trim() === "1";
        if (!exists) {
          env(`creating database ${db}`);
          await psql(`CREATE DATABASE ${db} OWNER kuutti`);
        }
      }
    }
  }
  env(`database ready at ${host}:${port} (${url.pathname.slice(1)})`);
}

async function migrateAndSeed(seed: boolean): Promise<void> {
  await streamed(
    "db",
    "32",
    "sh",
    ["-c", packageScript("packages/db", "migrate")],
    { DATABASE_URL },
    "packages/db",
  );
  if (seed)
    await streamed(
      "db",
      "32",
      "sh",
      ["-c", `${packageScript("packages/db", "seed")} --env development`],
      { DATABASE_URL },
      "packages/db",
    );
}

// ---------------------------------------------------------------- services

const children = new Map<string, ChildProcess>();

/** Synchronous best effort for the failure path; the graceful path is stopChildren(). */
function killChildrenNow(): void {
  for (const child of children.values()) {
    if (!child.pid) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
}

/** The package's own script (single source of truth), run the way pnpm would: sh, with .bin on PATH. */
function packageScript(dir: string, name: string): string {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, dir, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = manifest.scripts?.[name];
  if (!script) fail(`${dir}/package.json has no "${name}" script`);
  return script;
}

function startService(service: Service): void {
  const cwd = resolve(ROOT, service.dir);
  const command = [packageScript(service.dir, service.script), ...(service.extraArgs ?? [])].join(
    " ",
  );
  log(service.name, service.color, `$ ${command}`);
  const child = spawn("sh", ["-c", command], {
    cwd,
    env: {
      ...process.env,
      PATH: `${cwd}/node_modules/.bin:${ROOT}/node_modules/.bin:${process.env.PATH ?? ""}`,
      FORCE_COLOR: "1",
      DATABASE_URL,
      ...service.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  pipe(child, service.name, service.color);
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      log(
        service.name,
        "31",
        `exited (${signal ?? code}); the rest keeps running, Ctrl+C stops everything`,
      );
    }
  });
  children.set(service.name, child);
}

let shuttingDown = false;

async function stopChildren(): Promise<void> {
  shuttingDown = true;
  for (const [name, child] of children) {
    if (child.pid && (await alive(child.pid))) {
      env(`stopping ${name}`);
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const pids = [...children.values()]
      .map((c) => c.pid)
      .filter((p): p is number => p !== undefined);
    if (!(await Promise.all(pids.map(alive))).some(Boolean)) break;
    await sleep(200);
  }
  for (const child of children.values()) {
    if (child.pid && (await alive(child.pid))) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }
}

async function httpOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- commands

/**
 * Strict: a --skip without a usable value, a name that is no service, a misspelt flag, or a
 * flag on a command that takes none is refused before the database or a port is touched, never
 * read as no flag: a bare `--skip` started every app and freed the ports of the ones it was
 * meant to leave alone (#235). Throws the refusal, so --self-test can hold it.
 */
function parseArgs(argv: string[]) {
  const { values, positionals } = parseOptions({
    // pnpm hands the separator through: `pnpm env:up -- --skip mobile`.
    args: argv.filter((arg) => arg !== "--"),
    allowPositionals: true,
    options: { skip: { type: "string", multiple: true }, "no-seed": { type: "boolean" } },
  });
  const [command = "up", ...extra] = positionals;
  if (extra.length > 0) {
    throw new Error(
      `unexpected ${extra.join(" ")}: --skip takes one list, as in --skip mobile,admin`,
    );
  }
  if (command !== "up" && (values.skip || values["no-seed"])) {
    throw new Error(`--skip and --no-seed are for up, not ${command}`);
  }
  const names = SERVICES.map((s) => s.name);
  const skip = new Set<string>();
  for (const list of values.skip ?? []) {
    for (const name of list.split(",")) {
      if (!names.includes(name)) {
        throw new Error(
          `--skip takes a comma-separated list of ${names.join(", ")}, not "${list}"`,
        );
      }
      skip.add(name);
    }
  }
  return { command, skip, seed: !values["no-seed"] };
}

/**
 * The line a refused command line prints. Node's own messages go on with advice this script
 * refuses as well (`-- "--no-seeds"`, `--skip=-XYZ`), so their first sentence stays, then the usage.
 */
function refusal(error: unknown): string {
  return `${(error as Error).message.split(/\.\s/)[0]}; use ${USAGE}`;
}
const USAGE = "pnpm env:up [--skip api,mobile,admin] [--no-seed], env:down or env:status";

/** The command line's cases; touches no database, port or process. */
function selfTest(): never {
  const outcome = (argv: string[]) => {
    try {
      const { command, skip, seed } = parseArgs(argv);
      return `${command} skip=${[...skip].join(",")} seed=${seed}`;
    } catch (error) {
      return refusal(error);
    }
  };
  const no = (message: string) => `${message}; use ${USAGE}`;
  const list = (value: string) =>
    no(`--skip takes a comma-separated list of api, mobile, admin, not "${value}"`);
  const cases: Array<[string[], string]> = [
    [["up"], "up skip= seed=true"],
    [["up", "--skip", "mobile,admin", "--no-seed"], "up skip=mobile,admin seed=false"],
    [["up", "--skip=mobile"], "up skip=mobile seed=true"],
    [["up", "--", "--skip", "api", "--skip", "admin"], "up skip=api,admin seed=true"],
    [["status"], "status skip= seed=true"],
    [["up", "--skip"], no("Option '--skip <value>' argument missing")],
    [["up", "--skip", "--no-seed"], no("Option '--skip' argument is ambiguous")],
    [["up", "--skip="], list("")],
    [["up", "--skip", ""], list("")],
    [["up", "--skip", "mobil"], list("mobil")],
    [["up", "--skip", "mobile,"], list("mobile,")],
    [
      ["up", "--skip", "mobile", "admin"],
      no("unexpected admin: --skip takes one list, as in --skip mobile,admin"),
    ],
    [["up", "--no-seeds"], no("Unknown option '--no-seeds'")],
    [["down", "--skip", "mobile"], no("--skip and --no-seed are for up, not down")],
  ];
  const failed = cases.filter(([argv, expected]) => outcome(argv) !== expected);
  for (const [argv, expected] of failed) {
    console.error(`✖ self-test: ${JSON.stringify(argv)} gave ${outcome(argv)}, not ${expected}`);
  }
  // The refusal comes before the database and the ports: the script itself, with an empty PATH (no
  // docker, lsof or pnpm) and a DATABASE_URL that throws at its first use, prints it first and alone.
  const child = spawnSync(process.execPath, [import.meta.filename, "up", "--skip"], {
    env: { PATH: "", DATABASE_URL: "not a url" },
    encoding: "utf8",
  });
  const refused = `[env] ${no("Option '--skip <value>' argument missing")}\n`;
  const early = child.status === 1 && child.stdout === refused;
  if (!early)
    console.error(`✖ self-test: up --skip exited ${child.status}, printed ${child.stdout}`);
  if (failed.length > 0 || !early) process.exit(1);
  console.log(`✔ dev-env self-test: ${cases.length} command lines, refused before the database`);
  process.exit(0);
}

async function up(skip: Set<string>, seed: boolean): Promise<void> {
  const selected = SERVICES.filter((s) => !skip.has(s.name));
  env(
    `starting: database, ${selected.map((s) => s.name).join(", ") || "no apps"}${seed ? ", with seed" : ""}`,
  );
  if (!process.env.DATABASE_URL)
    env(`DATABASE_URL not set; using the local default ${DEFAULT_DATABASE_URL}`);

  await ensureDatabase();
  for (const service of selected) await freePort(service);
  await migrateAndSeed(seed);

  for (const service of selected) startService(service);
  for (const service of selected) {
    await waitFor(
      service.name,
      () => httpOk(service.readyUrl),
      service.name === "mobile" ? 120_000 : 60_000,
    );
    log(service.name, service.color, `ready at ${service.readyUrl}`);
  }

  env("everything is up. Ctrl+C stops the apps; `pnpm env:down` also stops the database.");
  if (!skip.has("api"))
    env("check: curl -s http://localhost:3000/health   (db ok, migrations current)");
  if (!skip.has("mobile"))
    env("check: open http://localhost:8081   (web target; the dev client uses the same Metro)");
  if (!skip.has("admin")) env("check: open http://localhost:5173   (the moderation panel)");
}

async function down(): Promise<void> {
  for (const service of SERVICES) await freePort(service);
  const url = new URL(DATABASE_URL);
  if (composeFile && (await hasDocker())) {
    await streamed("db", "32", "docker", ["compose", "down"]);
  }
  // Whatever still listens after compose is down is the Homebrew fallback.
  const brew = brewPostgres();
  if (brew && (await portOpen(url.hostname, Number(url.port || 5432)))) {
    env("stopping Homebrew PostgreSQL");
    const stopped = await run(brew.pgCtl, ["-D", brew.dataDir, "stop", "-m", "fast"]);
    if (stopped.code !== 0) env(`pg_ctl stop: ${stopped.err.trim() || stopped.out.trim()}`);
  }
  env("everything is down");
}

async function status(): Promise<void> {
  const url = new URL(DATABASE_URL);
  env(
    `database ${url.hostname}:${url.port || 5432}: ${(await portOpen(url.hostname, Number(url.port || 5432))) ? "listening" : "down"}`,
  );
  for (const service of SERVICES) {
    const owners = await listeners(service.port);
    if (owners.length === 0) log(service.name, service.color, `port ${service.port}: free`);
    for (const o of owners) {
      log(
        service.name,
        service.color,
        `port ${service.port}: pid ${o.pid} ${o.ours ? "(ours)" : "(NOT ours)"} ${o.command.slice(0, 90)}`,
      );
    }
  }
}

if (process.argv.includes("--self-test")) selfTest();
let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  fail(refusal(error));
}
const { command, skip, seed } = parsed;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    env("stopping");
    stopChildren().then(() => process.exit(0));
  });
}

if (command === "up") await up(skip, seed);
else if (command === "down") await down();
else if (command === "status") await status();
else fail(`unknown command ${command}; use up, down, or status`);
