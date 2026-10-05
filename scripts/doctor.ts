/**
 * doctor: is this machine ready for `pnpm env:up`?
 *
 * Checks Node, pnpm through Corepack, the git hooks, Docker with compose, the
 * root .env, a reachable database path, and the local ports. Prints the exact fix for each
 * failure. Exit 1 when something required is missing.
 *
 *   pnpm env:doctor   (pnpm doctor is pnpm's own command)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let failures = 0;

function ok(line: string): void {
  console.log(`  ✔ ${line}`);
}
function bad(line: string, fix: string, required = true): void {
  console.log(`  ${required ? "✖" : "▲"} ${line}\n      fix: ${fix}`);
  if (required) failures += 1;
}
function sh(cmd: string, args: string[]): { code: number | null; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

console.log("kuutti env:doctor\n");

// Node
const [major, minor] = process.versions.node.split(".").map(Number);
if ((major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 18))
  ok(`node ${process.versions.node}`);
else
  bad(
    `node ${process.versions.node} is too old`,
    "install Node 22.18 or newer (brew install node@22, or nodejs.org)",
  );

// pnpm via corepack, the version pinned in package.json
const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  packageManager?: string;
};
const pinned = manifest.packageManager?.split("+")[0] ?? "pnpm";
const pnpm = sh("pnpm", ["--version"]);
if (pnpm.code === 0 && pinned.endsWith(pnpm.out)) ok(`pnpm ${pnpm.out} (pinned ${pinned})`);
else if (pnpm.code === 0)
  bad(
    `pnpm ${pnpm.out} differs from the pinned ${pinned}`,
    "run `corepack enable`; Corepack then uses the pinned version automatically",
    false,
  );
else
  bad(
    "pnpm not found",
    "run `corepack enable` once (Corepack ships with Node) and open a new shell",
  );

// The repository's hooks: the sign-off check and Biome on the staged files.
// Not required to run anything, so a warning; CI checks both in any case.
const hooks = sh("git", ["-C", ROOT, "config", "--get", "core.hooksPath"]);
if (hooks.code === 0 && hooks.out === ".githooks") ok("git hooks on (.githooks)");
else
  bad(
    "git hooks are off: an unsigned or unformatted commit is only refused by CI",
    "git config core.hooksPath .githooks",
    false,
  );

// Docker with compose
const docker = sh("docker", ["compose", "version"]);
if (docker.code === 0) ok(docker.out.split("\n")[0] ?? "docker compose");
else {
  const brewPg = ["17", "18", "16"].some((v) =>
    existsSync(`/opt/homebrew/opt/postgresql@${v}/bin/pg_ctl`),
  );
  bad(
    "docker compose not available (Postgres, the S3 stand-in and the mock bank IdP run in compose)",
    `install Docker Desktop or OrbStack, then start it${brewPg ? ". Until then env:up falls back to Homebrew PostgreSQL; the S3 stand-in and the mock IdP stay unavailable" : ""}`,
  );
}

// .env
if (existsSync(resolve(ROOT, ".env"))) ok(".env present at the repository root");
else bad(".env missing", "cp env.example .env");

// Ports
const PORTS: [number, string][] = [
  [3000, "api"],
  [8081, "metro"],
  [5173, "admin"],
  [5432, "postgres"],
  [9000, "s3 stand-in (versitygw)"],
  [8080, "mock idp"],
];
for (const [port, name] of PORTS) {
  const lsof = sh("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  const pids = lsof.out.split(/\s+/).filter(Boolean);
  if (pids.length === 0) ok(`port ${port} (${name}) free`);
  else {
    const cmd = sh("ps", ["-o", "command=", "-p", pids[0] as string]).out.slice(0, 70);
    ok(
      `port ${port} (${name}) in use by pid ${pids[0]}: ${cmd} (env:up replaces our own stale processes, refuses others)`,
    );
  }
}

console.log(failures === 0 ? "\nready: pnpm env:up" : `\n${failures} required check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
