/**
 * e2e:admin: the moderation panel's flows in Chromium against the local stack (#106, ADR-051).
 *
 *   pnpm e2e:admin                             every flow, headless
 *   pnpm e2e:admin -- --headed                 Playwright's own flags and file filters pass through
 *   pnpm e2e:admin -- e2e/photos.spec.ts       one file
 *   node apps/admin/e2e/run.ts --self-test     the host's headers, the guards and the server; starts nothing
 *
 * It needs docker compose's Postgres, mock bank and S3 stand-in (`docker compose up -d --wait`, or
 * `pnpm env:up`) and the release of pictures (`pnpm demo:assets`), and nothing else of the local
 * environment: the database, the bucket, the API and the panel are its own, on ports of their own,
 * so a run writes nothing the shared stack holds and needs nobody's API on 3000. One run at a
 * time on a machine: a second waits for nothing and stops, said so. In order:
 *
 *   1. A database and a bucket of its own, kuutti_test_admin_e2e in Postgres and
 *      kuutti-test-admin-e2e in the stand-in, made anew; the database migrated and seeded. A
 *      photo's objects are named by its content, so the cast's pictures in the shared bucket have
 *      the very names this run's would: in a bucket of its own, neither side's erasure takes the
 *      other's.
 *   2. The API from source against both, configured from env.example and never from .env (rule 9),
 *      its log in e2e/.out/api.log.
 *   3. The cast's stories through the API's own routes (`demo:reset`: Noa's photos wait in review
 *      among them), then what the flows act on: Mikael signs in once as anybody does and is made a
 *      moderator with the maintainer's own command line (ADR-006 §5), Emmi sends Laura a photo and
 *      Laura reports their conversation pointing at it (#476), and Iida's round names the person
 *      whose page the sanction flow opens.
 *   4. The panel's production build against that API, served with the headers of
 *      infra/modules/admin/main.tf, read from the file: its CSP, with the S3 stand-in added to
 *      img-src alone, for the photo URLs the API presigns on it locally (deployed, a photo comes
 *      from the API's own origin through CloudFront).
 *   5. Playwright, which fails a flow on any console error or warning, uncaught error or CSP
 *      violation on the panel (fixtures.ts).
 *   6. Everything stopped, the bucket emptied and removed and the database dropped, whether the
 *      flows passed or not, a signal included. A run killed outright leaves them for the next run,
 *      which makes both anew.
 *
 * What each step wrote is in e2e/.out/setup.log; a step that fails prints its end.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { ChatMessage, ConversationList, RoundResponse } from "@kuutti/schema";
import { createPool } from "../../../packages/db/src/pool.ts";
import { DEMO_PERSONAS } from "../../../packages/db/src/seed/personas.ts";
import { demoAssetsDir } from "../../../packages/db/src/seed/photos.ts";
// By path: these are command lines' tools (the demo tools' rule), and the panel imports nothing of them.
import { type BankContext, call, loginAs } from "../../api/scripts/demo/bank.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const ADMIN = resolve(ROOT, "apps/admin");
const OUT = resolve(ADMIN, "e2e/.out");
const HOST_MODULE = resolve(ROOT, "infra/modules/admin/main.tf");
/** Made anew on every run and dropped after it; never the shared `kuutti`, which other sessions use. */
const DATABASE = "kuutti_test_admin_e2e";
/** The stand-in's bucket of the run, beside the shared kuutti-media; made and removed as the database is. */
const BUCKET = "kuutti-test-admin-e2e";
/** The advisory lock a run holds on the database server from its first step to its last. */
const LOCK = "kuutti-e2e-admin";
/** Who the flows sign in as: Mikael, a newcomer the stories give no history, so staff and nothing else. */
const MODERATOR = "mikael";
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

type Pool = ReturnType<typeof createPool>;

async function main(argv: string[]): Promise<number> {
  const template = parseEnv(readFileSync(resolve(ROOT, "env.example"), "utf8"));
  let databaseUrl: string;
  let store: S3Client;
  try {
    databaseUrl = privateDatabase(template.DATABASE_URL ?? "", DATABASE);
    store = localStore(template);
  } catch (error) {
    console.error(`e2e:admin: ${(error as Error).message}`);
    return 1;
  }
  const photos = demoAssetsDir();
  if (!existsSync(photos)) {
    console.error(`e2e:admin: no pictures in ${photos}; run pnpm demo:assets first`);
    return 1;
  }

  const [apiPort, panelPort] = [await freePort(), await freePort()];
  const api = `http://localhost:${apiPort}`;
  const panel = `http://localhost:${panelPort}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...template,
    DATABASE_URL: databaseUrl,
    S3_BUCKET: BUCKET,
    PORT: String(apiPort),
    // The bank returns staff to this panel, and the API answers its origin alone.
    ADMIN_APP_URL: panel,
    CORS_ALLOWED_ORIGINS: panel,
    // The mock bank takes any redirect URI (services/mock-idp/README.md).
    OIDC_REDIRECT_URI: `${api}/auth/callback`,
  };
  const stack = new Stack(databaseUrl, store, env);
  try {
    if (!(await stack.lock())) {
      console.error("e2e:admin: another run holds the stack on this machine; run again after it");
      return 1;
    }
  } catch (error) {
    console.error(`e2e:admin: ${(error as Error).message}`);
    return 1;
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const stop = () => {
    void stack.down().then(() => process.exit(130));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await stack.database(true);
    await stack.bucket(true);
    stack.step("migrate", ["--import", "tsx", "src/cli/migrate.ts"], "packages/db");
    stack.step(
      "seed",
      ["--import", "tsx", "src/cli/seed.ts", "--env", "development"],
      "packages/db",
    );
    await stack.api(api);
    stack.step(
      "the cast's stories",
      ["--import", "tsx", "scripts/demo-reset.ts", "--api", api],
      "apps/api",
    );
    const cast = await stack.cast(api);
    const headers = hostHeaders(readFileSync(HOST_MODULE, "utf8"), api, [
      new URL(template.S3_ENDPOINT ?? "").origin,
    ]);
    stack.step(
      "the panel's production build",
      [
        resolve(ROOT, "node_modules/vite/bin/vite.js"),
        "build",
        "--outDir",
        resolve(OUT, "panel"),
        "--emptyOutDir",
      ],
      "apps/admin",
      { VITE_API_URL: api },
    );
    await stack.serve(resolve(OUT, "panel"), headers, panelPort);
    console.log(`e2e:admin: the panel at ${panel}, the API at ${api}, database ${DATABASE}`);
    return await stack.flows(playwrightArgs(argv), {
      ...process.env,
      E2E_PANEL_URL: panel,
      E2E_PERSON_ACCOUNT: cast.personAccount,
    });
  } catch (error) {
    console.error(`e2e:admin: ${(error as Error).message}`);
    return 1;
  } finally {
    await stack.down();
  }
}

/**
 * The local stack's private part: the lock, the database, the bucket, the API, the panel's server
 * and the flows, and their ending.
 */
class Stack {
  private readonly log = resolve(OUT, "setup.log");
  private holder: { pool: Pool; release: () => void } | null = null;
  private apiProcess: ChildProcess | null = null;
  private flowsProcess: ChildProcess | null = null;
  private server: Server | null = null;
  private stopping: Promise<void> | null = null;
  private readonly databaseUrl: string;
  private readonly store: S3Client;
  private readonly env: NodeJS.ProcessEnv;

  constructor(databaseUrl: string, store: S3Client, env: NodeJS.ProcessEnv) {
    this.databaseUrl = databaseUrl;
    this.store = store;
    this.env = env;
  }

  private maintenanceUrl(): string {
    const server = new URL(this.databaseUrl);
    server.pathname = "/postgres";
    return server.toString();
  }

  /**
   * Takes the run's lock, on a connection of its own kept for the whole run (an idle pool would
   * hand it back): false while another run holds it. On the server's maintenance database, which
   * the drop of the run's database does not end.
   */
  async lock(): Promise<boolean> {
    const pool = createPool({
      connectionString: this.maintenanceUrl(),
      max: 1,
      applicationName: "kuutti-e2e-admin-lock",
    });
    const client = await pool.connect().catch(async (error: Error) => {
      await pool.end();
      throw new Error(
        `the database server did not answer (${error.message}); start the stack: docker compose up -d --wait`,
      );
    });
    const { rows } = await client.query<{ held: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS held",
      [LOCK],
    );
    if (rows[0]?.held !== true) {
      client.release();
      await pool.end();
      return false;
    }
    this.holder = { pool, release: () => client.release() };
    return true;
  }

  /** Makes the database anew (`fresh`) or drops it; a session left on it from a run that died goes too. */
  async database(fresh: boolean): Promise<void> {
    const admin = createPool({
      connectionString: this.maintenanceUrl(),
      max: 1,
      applicationName: "kuutti-e2e-admin",
    });
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      if (fresh) await admin.query(`CREATE DATABASE ${DATABASE}`);
    } finally {
      await admin.end();
    }
  }

  /** Empties and removes the run's bucket, a dead run's included, then makes it anew (`fresh`). */
  async bucket(fresh: boolean): Promise<void> {
    try {
      let token: string | undefined;
      do {
        const page = await this.store.send(
          new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token }),
        );
        const keys = (page.Contents ?? []).flatMap((object) =>
          object.Key ? [{ Key: object.Key }] : [],
        );
        if (keys.length > 0) {
          await this.store.send(
            new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys, Quiet: true } }),
          );
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      await this.store.send(new DeleteBucketCommand({ Bucket: BUCKET }));
    } catch (error) {
      if ((error as Error).name !== "NoSuchBucket") throw error;
    }
    if (fresh) await this.store.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }

  /** One command of the repository, its output in setup.log; a failure prints the log's end. */
  step(title: string, args: string[], cwd: string, extra: NodeJS.ProcessEnv = {}): void {
    console.log(`e2e:admin: ${title}`);
    const fd = openSync(this.log, "a");
    writeFileSync(fd, `\n--- ${title}\n`);
    const run = spawnSync(process.execPath, args, {
      cwd: resolve(ROOT, cwd),
      env: { ...this.env, ...extra },
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    if (run.status !== 0) {
      const tail = readFileSync(this.log, "utf8").split("\n").slice(-30).join("\n");
      throw new Error(`${title} failed (exit ${run.status ?? run.signal}):\n${tail}`);
    }
  }

  /** The API from source, as `pnpm dev` runs it but without .env, once it answers /health. */
  async api(origin: string): Promise<void> {
    console.log("e2e:admin: the API");
    const fd = openSync(resolve(OUT, "api.log"), "a");
    this.apiProcess = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: resolve(ROOT, "apps/api"),
      env: this.env,
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    // A runner that dies another way than through down() takes the API with it; the next run
    // makes the database and the bucket anew.
    const api = this.apiProcess;
    process.once("exit", () => api.kill());
    for (let attempt = 0; attempt < 120; attempt++) {
      if (!running(api)) break;
      const health = await fetch(`${origin}/health`).catch(() => null);
      if (health?.ok) return;
      await new Promise((wait) => setTimeout(wait, 500));
    }
    const tail = readFileSync(resolve(OUT, "api.log"), "utf8").split("\n").slice(-30).join("\n");
    throw new Error(`the API did not answer /health:\n${tail}`);
  }

  /**
   * What the flows act on, beyond the stories: a moderator, a report and a person to sanction.
   * Each through the API as the app sends it, and the role through the maintainer's command line,
   * granted to the identity that signed in last (its `recent`), as the maintainer grants it:
   * Mikael's sign-in just now, in a database nobody else signs in to. The flows' own sign-in
   * then shows the role is his.
   */
  async cast(api: string): Promise<{ personAccount: string }> {
    console.log("e2e:admin: a moderator, a report and a person to sanction");
    const context: BankContext = {
      api,
      fetch: (input, init) => fetch(input, init),
      now: () => new Date(),
    };
    const session = async (key: string) => {
      const persona = DEMO_PERSONAS.find((p) => p.key === key);
      if (!persona) throw new Error(`no persona ${key}`);
      const login = await loginAs(persona, context, "en");
      if (login.kind !== "session")
        throw new Error(`${key}'s bank login was refused: ${login.error}`);
      return login.accessToken;
    };

    await session(MODERATOR);
    const recent = this.moderator(["recent"]).split("\n")[0]?.split(" ")[0] ?? "";
    this.moderator(["grant", recent, "moderator", "--by", "e2e:admin"]);

    const laura = await session("laura");
    const conversations = ConversationList.parse(
      await call(context, laura, "GET", "/conversations"),
    );
    const withEmmi = conversations.open.find(
      (c) => c.counterpart?.deleted === false && c.counterpart.name === "Emmi",
    );
    if (!withEmmi)
      throw new Error("Laura has no open conversation with Emmi: did the stories run?");
    // Emmi sends Laura a photo through the chat's own route, and Laura's report
    // points at it (#476). Here only: this stack's database and bucket go with
    // the run, so no copy holds the photo past it.
    const emmi = await session("emmi");
    const form = new FormData();
    const picture = readFileSync(join(demoAssetsDir(), "negatives/beer.jpg"));
    form.append("photo", new Blob([new Uint8Array(picture)], { type: "image/jpeg" }), "photo.jpg");
    form.append("clientId", "4b8f0c1e-6d2a-4e7b-9f3c-1a2b3c4d5e6f");
    const sent = await fetch(new URL(`/conversations/${withEmmi.id}/photos`, api), {
      method: "POST",
      headers: { authorization: `Bearer ${emmi}` },
      body: form,
    });
    if (!sent.ok) throw new Error(`Emmi's photo to Laura was refused: ${sent.status}`);
    const { seq } = ChatMessage.parse(await sent.json());
    await call(context, laura, "POST", `/conversations/${withEmmi.id}/report`, {
      reason: "harassment",
      note: "She called me names when I said no.",
      seq,
    });

    const iida = await session("iida");
    const round = RoundResponse.parse(await call(context, iida, "GET", "/rounds/today"));
    const riikka = round.entries?.find((entry) => entry.card.displayName === "Riikka");
    if (!riikka) throw new Error("Iida's round has no Riikka: did the stories run?");
    return { personAccount: riikka.card.accountId };
  }

  private moderator(args: string[]): string {
    const run = spawnSync(process.execPath, ["--import", "tsx", "src/cli/moderator.ts", ...args], {
      cwd: resolve(ROOT, "packages/db"),
      env: this.env,
      encoding: "utf8",
    });
    if (run.status !== 0) throw new Error(`moderator ${args[0]} failed: ${run.stderr}`);
    return run.stdout;
  }

  /** The panel's server; a port taken meanwhile is an error of the run, not of the process. */
  async serve(dir: string, headers: Record<string, string>, port: number): Promise<void> {
    const server = panelServer(dir, headers);
    this.server = server;
    await new Promise<void>((ready, failed) => {
      server.once("error", failed);
      server.listen(port, "localhost", () => {
        server.off("error", failed);
        ready();
      });
    });
  }

  /** Playwright, its output the terminal's; its exit code is the run's. */
  async flows(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
    const flows = spawn(
      process.execPath,
      [resolve(ROOT, "node_modules/@playwright/test/cli.js"), "test", ...args],
      { cwd: ADMIN, stdio: "inherit", env },
    );
    this.flowsProcess = flows;
    return await new Promise<number>((done) => flows.once("exit", (code) => done(code ?? 1)));
  }

  /**
   * Stops what runs, removes the bucket, drops the database and lets the lock go; said, never
   * thrown, so the next part still happens. Once: a signal during the teardown waits for it.
   */
  down(): Promise<void> {
    this.stopping ??= this.tearDown();
    return this.stopping;
  }

  private async tearDown(): Promise<void> {
    const warn = (error: unknown) => console.warn(`e2e:admin: ${(error as Error).message}`);
    await ended(this.flowsProcess, "SIGINT");
    const server = this.server;
    if (server) {
      // Chromium keeps its connections alive; close() alone would wait for them.
      server.closeAllConnections();
      await new Promise((closed) => server.close(closed));
    }
    await ended(this.apiProcess, "SIGTERM");
    if (this.holder) {
      await this.bucket(false).catch(warn);
      await this.database(false).catch(warn);
      this.holder.release();
      await this.holder.pool.end().catch(warn);
      this.holder = null;
    }
  }
}

/** Whether a child is still running: one ended by a signal has an exit code of null too. */
function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** Ends a child that still runs, and waits: ten seconds for `signal`, then SIGKILL. */
async function ended(child: ChildProcess | null, signal: NodeJS.Signals): Promise<void> {
  if (!child || !running(child)) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill(signal);
  const late = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(late);
}

/** Playwright's arguments: what follows `pnpm e2e:admin --`, the separator itself left out. */
function playwrightArgs(argv: readonly string[]): string[] {
  return argv[0] === "--" ? argv.slice(1) : [...argv];
}

/**
 * The database the run may write: on this computer, named kuutti_test_ and something. Anything
 * else is refused before a connection is made, the shared `kuutti` first of all.
 */
function privateDatabase(template: string, name: string): string {
  const url = new URL(template);
  if (!LOOPBACK.includes(url.hostname)) {
    throw new Error(`the database server ${url.hostname} is not on this computer`);
  }
  if (!/^kuutti_test_[a-z0-9_]+$/.test(name))
    throw new Error(`${name} is not a private test database`);
  url.pathname = `/${name}`;
  return url.toString();
}

/** The S3 stand-in of env.example, on this computer and addressed by path, or nothing. */
function localStore(template: Record<string, string | undefined>): S3Client {
  const endpoint = new URL(template.S3_ENDPOINT ?? "");
  if (!LOOPBACK.includes(endpoint.hostname)) {
    throw new Error(`the object store ${endpoint.hostname} is not on this computer`);
  }
  return new S3Client({
    endpoint: endpoint.origin,
    region: template.S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: template.S3_ACCESS_KEY ?? "",
      secretAccessKey: template.S3_SECRET_KEY ?? "",
    },
  });
}

/**
 * The headers the panel's distribution sends (the response-headers policy of
 * infra/modules/admin/main.tf), read from the module so the flows run under the policy that ships
 * and not under a copy of it. The API's origin stands where the module names `var.api_origin`;
 * `localImages` join img-src and nothing else. A policy this reading does not follow (another
 * variable, a directive or a block it cannot find, a custom header it cannot read) is an error,
 * never a looser policy.
 */
function hostHeaders(
  tf: string,
  apiOrigin: string,
  localImages: readonly string[],
): Record<string, string> {
  const list = /content_security_policy\s*=\s*join\("; ",\s*\[([\s\S]*?)\]\)/.exec(tf)?.[1];
  if (!list) throw new Error('no content_security_policy = join("; ", [...]) in the module');
  const directives = list
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .flatMap((line) => [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? ""))
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the module's own interpolation, matched as text.
    .map((directive) => directive.replaceAll("${var.api_origin}", apiOrigin));
  const unknown = directives.find((directive) => directive.includes("${"));
  if (unknown) throw new Error(`the policy names what this run cannot fill in: ${unknown}`);
  if (!directives.some((directive) => directive.startsWith("img-src "))) {
    throw new Error("the policy has no img-src");
  }
  const csp = directives
    .map((directive) =>
      directive.startsWith("img-src ") ? [directive, ...localImages].join(" ") : directive,
    )
    .join("; ");

  const block = (name: string) => {
    const body = new RegExp(`${name}\\s*\\{([^}]*)\\}`).exec(tf)?.[1];
    if (body === undefined) throw new Error(`no ${name} block in the module`);
    return body;
  };
  // An attribute on its own line; a comment line between them is passed over.
  const attribute = (body: string, key: string) =>
    new RegExp(`^\\s*${key}\\s*=\\s*("([^"\\\\]*)"|true|false|\\d+)\\s*$`, "m").exec(body);
  const text = (body: string, key: string, where: string) => {
    const found = attribute(body, key)?.[2];
    if (!found) throw new Error(`no ${key} in the module's ${where}`);
    return found;
  };

  const hsts = block("strict_transport_security");
  const maxAge = attribute(hsts, "access_control_max_age_sec")?.[1];
  if (!maxAge) throw new Error("no access_control_max_age_sec in strict_transport_security");
  const headers: Record<string, string> = {
    "Content-Security-Policy": csp,
    "Strict-Transport-Security": [
      `max-age=${maxAge}`,
      ...(attribute(hsts, "include_subdomains")?.[1] === "true" ? ["includeSubDomains"] : []),
      ...(attribute(hsts, "preload")?.[1] === "true" ? ["preload"] : []),
    ].join("; "),
    "Referrer-Policy": text(block("referrer_policy"), "referrer_policy", "referrer_policy"),
    "X-Frame-Options": text(block("frame_options"), "frame_option", "frame_options"),
  };
  // The block has no value of its own: CloudFront's header is nosniff.
  block("content_type_options");
  headers["X-Content-Type-Options"] = "nosniff";

  const custom = tf.slice(tf.indexOf("custom_headers_config"));
  const items = [...custom.slice(0, custom.search(/^\}/m)).matchAll(/items\s*\{([^}]*)\}/g)];
  if (items.length === 0) throw new Error("no custom header in the module's custom_headers_config");
  for (const [, body = ""] of items) {
    headers[text(body, "header", "custom header")] = text(body, "value", "custom header");
  }
  return headers;
}

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
};

/**
 * The bucket behind CloudFront, as the panel sees it: a file is itself, any other path is
 * index.html with 200 (the distribution's 403 and 404 answers, #302), an address that names no
 * key a client could hold included, every answer with the policy's headers.
 */
function panelServer(dir: string, headers: Record<string, string>): Server {
  const root = resolve(dir);
  return createServer((incoming, response) => {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    if (incoming.method !== "GET" && incoming.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    let file = join(root, "index.html");
    try {
      const path = normalize(
        decodeURIComponent(new URL(incoming.url ?? "/", "http://panel").pathname),
      );
      const asked = join(root, path);
      if (asked.startsWith(root + sep) && existsSync(asked) && statSync(asked).isFile()) {
        file = asked;
      }
    } catch {
      // A malformed escape names no file: the app answers it, as CloudFront would.
    }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(incoming.method === "HEAD" ? undefined : readFileSync(file));
  });
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ready) => probe.listen(0, "localhost", ready));
  const { port } = probe.address() as AddressInfo;
  await new Promise((closed) => probe.close(closed));
  return port;
}

/** A GET with the path exactly as written: fetch and URL would resolve dot segments first. */
function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((done, failed) => {
    const asked = request({ host: "localhost", port, path, method: "GET" }, (answer) => {
      let body = "";
      answer.setEncoding("utf8");
      answer.on("data", (chunk: string) => {
        body += chunk;
      });
      answer.on("end", () => done({ status: answer.statusCode ?? 0, body }));
    });
    asked.on("error", failed);
    asked.end();
  });
}

async function selfTest(): Promise<never> {
  const failures: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) failures.push(name);
  };
  const throws = (name: string, run: () => unknown) => {
    try {
      run();
      failures.push(`${name}: did not throw`);
    } catch {
      // Refused, as it should be.
    }
  };

  const api = "http://localhost:3000";
  const stand = "http://127.0.0.1:9000";
  const shipped = hostHeaders(readFileSync(HOST_MODULE, "utf8"), api, [stand]);
  const csp = (shipped["Content-Security-Policy"] ?? "").split("; ");
  check("the shipped policy refuses by default", csp[0] === "default-src 'none'");
  check("scripts are the panel's own", csp.includes("script-src 'self'"));
  check("styles are the panel's own, inline refused", csp.includes("style-src 'self'"));
  check("the API is the one connection", csp.includes(`connect-src ${api}`));
  check("the stand-in joins img-src", csp.includes(`img-src 'self' ${api} ${stand}`));
  check("the stand-in joins nothing else", csp.filter((d) => d.includes(stand)).length === 1);
  check("no worker", csp.includes("worker-src 'none'"));
  check("no frame", csp.includes("frame-ancestors 'none'"));
  check("no comment of the module in the policy", !csp.some((d) => d.includes("service worker")));
  check("no referrer", shipped["Referrer-Policy"] === "no-referrer");
  check("never framed", shipped["X-Frame-Options"] === "DENY");
  check("no sniffing", shipped["X-Content-Type-Options"] === "nosniff");
  check("the opener isolated", shipped["Cross-Origin-Opener-Policy"] === "same-origin");
  check(
    "the resources kept to the origin",
    shipped["Cross-Origin-Resource-Policy"] === "same-origin",
  );
  check("no camera", shipped["Permissions-Policy"] === "camera=(), microphone=(), geolocation=()");
  check("not indexed", shipped["X-Robots-Tag"] === "noindex, nofollow");
  check(
    "HSTS as shipped",
    shipped["Strict-Transport-Security"] === "max-age=63072000; includeSubDomains; preload",
  );
  check("nothing more than the module's nine headers", Object.keys(shipped).length === 9);

  const fixture = (directives: string, extra = "") => `
    content_security_policy {
      content_security_policy = join("; ", [
${directives}
      ])
    }
    strict_transport_security {
      access_control_max_age_sec = 1
      include_subdomains         = false
      preload                    = false
    }
    content_type_options {
      override = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
    }
    frame_options {
      frame_option = "DENY"
    }
  }

  custom_headers_config {
    items {
      # a comment between the two
      value    = "same-origin"
      header   = "Cross-Origin-Opener-Policy"
      override = true
    }
${extra}
  }
}
`;
  const own = `"img-src 'self' \${var.api_origin}",`;
  const minimal = hostHeaders(fixture(own), api, []);
  check(
    "no stand-in when none is given",
    minimal["Content-Security-Policy"] === `img-src 'self' ${api}`,
  );
  check(
    "HSTS without its flags when the module sets none",
    minimal["Strict-Transport-Security"] === "max-age=1",
  );
  check(
    "a custom header read whatever the order, past a comment",
    minimal["Cross-Origin-Opener-Policy"] === "same-origin",
  );
  throws("a policy naming another variable", () =>
    hostHeaders(fixture(`"img-src 'self' \${var.media_origin}",`), api, []),
  );
  throws("a module without the policy", () =>
    hostHeaders('referrer_policy = "no-referrer"', api, []),
  );
  throws("a policy without img-src", () =>
    hostHeaders(fixture(`"default-src 'none'",`), api, [stand]),
  );
  throws("a custom header without its value", () =>
    hostHeaders(fixture(own, '    items {\n      header = "X-Robots-Tag"\n    }'), api, []),
  );
  throws("a custom header whose value is not a string", () =>
    hostHeaders(
      fixture(own, '    items {\n      header = "X-Robots-Tag"\n      value = var.robots\n    }'),
      api,
      [],
    ),
  );
  throws("no frame options", () =>
    hostHeaders(fixture(own).replace(/frame_options \{[^}]*\}/, ""), api, []),
  );

  check(
    "the separator pnpm passes on is left out",
    playwrightArgs(["--", "--headed"]).join(" ") === "--headed",
  );
  check(
    "a file filter passes as it is",
    playwrightArgs(["e2e/photos.spec.ts"]).join(" ") === "e2e/photos.spec.ts",
  );
  check("nothing asked is nothing passed", playwrightArgs(["--"]).length === 0);

  // The role is set on the URL, never written into one: the secret scan reads a written
  // user:password@host as a credential, a placeholder too.
  const local = new URL("postgres://127.0.0.1:5432/kuutti");
  local.username = "kuutti";
  local.password = "kuutti";
  throws("the shared database", () => privateDatabase(local.toString(), "kuutti"));
  throws("a server elsewhere", () =>
    privateDatabase("postgres://db.example.org:5432/kuutti", DATABASE),
  );
  const database = new URL(privateDatabase(local.toString(), DATABASE));
  check(
    "the private database on this computer, as the same role",
    database.host === "127.0.0.1:5432" &&
      database.pathname === `/${DATABASE}` &&
      database.username === "kuutti" &&
      database.password === "kuutti",
  );
  throws("a store elsewhere", () =>
    localStore({ S3_ENDPOINT: "https://s3.eu-central-1.amazonaws.com" }),
  );
  check(
    "the stand-in on this computer",
    localStore({ S3_ENDPOINT: stand, S3_REGION: "eu-central-1" }) instanceof S3Client,
  );

  const dir = mkdtempSync(join(tmpdir(), "kuutti-e2e-admin-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>panel</title>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "export {};");
  const secret = join(tmpdir(), "kuutti-e2e-admin-secret.txt");
  writeFileSync(secret, "outside");
  const server = panelServer(dir, { "Content-Security-Policy": "default-src 'none'" });
  await new Promise<void>((ready) => server.listen(0, "localhost", ready));
  const port = (server.address() as AddressInfo).port;
  const base = `http://localhost:${port}`;
  try {
    const asset = await fetch(`${base}/assets/app.js`);
    check("a file is itself", (await asset.text()) === "export {};");
    check(
      "a script's type",
      asset.headers.get("content-type")?.startsWith("text/javascript") === true,
    );
    check(
      "every answer carries the policy",
      asset.headers.get("content-security-policy") === "default-src 'none'",
    );
    const page = await fetch(`${base}/reports/123`);
    check("a path is the app", page.status === 200 && (await page.text()).includes("<title>panel"));
    for (const path of [
      "/../kuutti-e2e-admin-secret.txt",
      "/assets/../../kuutti-e2e-admin-secret.txt",
      "/%2e%2e%2fkuutti-e2e-admin-secret.txt",
      "/assets/%2e%2e/%2e%2e/kuutti-e2e-admin-secret.txt",
    ]) {
      const out = await rawGet(port, path);
      check(
        `nothing outside the build: ${path}`,
        out.status === 200 && !out.body.includes("outside"),
      );
    }
    const malformed = await rawGet(port, "/%E0%A4%A");
    check(
      "a malformed escape is the app",
      malformed.status === 200 && malformed.body.includes("<title>panel"),
    );
    check("no writing", (await fetch(`${base}/`, { method: "POST" })).status === 405);
  } finally {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
    rmSync(dir, { recursive: true, force: true });
    rmSync(secret, { force: true });
  }

  if (failures.length > 0) {
    console.error(`e2e:admin self-test: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log(
    "e2e:admin self-test: the host's headers, the arguments, the private database and store, and the server hold",
  );
  process.exit(0);
}

// Last, so every constant above is set before either runs.
if (process.argv.includes("--self-test")) await selfTest();
else process.exitCode = await main(process.argv.slice(2));
