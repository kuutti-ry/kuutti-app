/**
 * fonts: Saiga, Kuutti's typeface, onto this machine and never into the
 * checkout (ADR-052, #394).
 *
 * Saiga is Spoke Type's, licensed to Kuutti ry for the Kuutti app and the
 * media of the Kuutti brand (Spoke's e-mail of 20-21/10/2026). Its files are
 * never public as sources: not in this repository, which is public, and not
 * on a GitHub runner, whose caches, artifacts and logs are. They live in the
 * association's private repository, `kuutti-app-fonts`.
 *
 * This takes the faces of scripts/saiga.json from that repository at the
 * pinned commit, holds every file to the SHA-256 of the one Spoke delivered,
 * and writes them, only once all of them are verified, to
 * ~/.cache/kuutti-fonts/saiga-<version>/{TTF,WOFF2}/. There the app's native
 * build finds the TTF faces (apps/mobile/plugins/withSaiga.js), and the web
 * target's and the panel's dev servers the WOFF2 ones. Nothing under the
 * repository is written.
 *
 * It runs in two places, never in a GitHub workflow (it refuses one, and
 * check-workflow-permissions.py refuses a workflow that names it):
 * - a member's laptop, with the member's own `gh` login;
 * - the EAS builder, as apps/mobile's eas-build-pre-install hook, before the
 *   install, which is why it has no dependencies. Its credential there is
 *   FONTS_TOKEN, a read-only token for that one repository, which the
 *   maintainer keeps as an EAS secret.
 * Without a credential, or without access, it says so and exits 0: the app is
 * then built in the system font. With --soft (the hook) nothing fails it: a
 * build in the system font beats no build.
 *
 * Usage:
 *   pnpm fonts                          fetch what is missing, verify it
 *   pnpm fonts -- --check               verify what is here; exit 1 if any is missing
 *   pnpm fonts -- --upload <bucket>     the maintainer's: the WOFF2 faces to the panel's
 *                                       bucket, under fonts/saiga-<version>/ (`pnpm aws:login` first)
 *   node scripts/fonts.ts --self-test
 * Never prints the credential. Needs Node 22.18+ (type stripping).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

type Face = { name: string; weight: number; style: string; ttf: string; woff2: string };
type Saiga = { version: string; repository: string; commit: string; faces: Face[] };
/** A file this machine wants: where it is in the repository, where it lands, its SHA-256. */
type Wanted = { source: string; local: string; sha256: string };
type Get = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

const SAIGA = JSON.parse(readFileSync(join(import.meta.dirname, "saiga.json"), "utf8")) as Saiga;
const FORMATS = [
  { folder: "TTF", ext: "ttf", sum: (face: Face) => face.ttf },
  { folder: "WOFF2", ext: "woff2", sum: (face: Face) => face.woff2 },
] as const;
/** Answers that mean "not yours to read": no token, a wrong one, or not a member. */
const NO_ACCESS = new Set([401, 403, 404]);
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** ~/.cache/kuutti-fonts/saiga-<version>, the folder the builds and dev servers read. */
function saigaDir(home: string = homedir()): string {
  return join(home, ".cache", "kuutti-fonts", `saiga-${SAIGA.version}`);
}

function wanted(dir: string): Wanted[] {
  return FORMATS.flatMap(({ folder, ext, sum }) =>
    SAIGA.faces.map((face) => ({
      source: `Saiga/${folder}/${face.name}.${ext}`,
      local: join(dir, folder, `${face.name}.${ext}`),
      sha256: sum(face),
    })),
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The wanted files that are not here as Spoke delivered them. */
function missing(list: readonly Wanted[]): Wanted[] {
  return list.filter(({ local, sha256: sum }) => {
    try {
      return sha256(readFileSync(local)) !== sum;
    } catch {
      return true;
    }
  });
}

class NoAccess extends Error {}

/**
 * Every file of the list, verified, or an error that names the file and what
 * went wrong. The credential goes into a header and nowhere else.
 */
async function fetchAll(
  list: readonly Wanted[],
  token: string,
  get: Get = fetch,
): Promise<Array<{ file: Wanted; bytes: Uint8Array }>> {
  const fetched = [];
  for (const file of list) {
    const answer = await get(
      `https://api.github.com/repos/${SAIGA.repository}/contents/${file.source}?ref=${SAIGA.commit}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.raw+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (NO_ACCESS.has(answer.status)) {
      throw new NoAccess(`GitHub answered ${answer.status} for ${SAIGA.repository}`);
    }
    if (!answer.ok) throw new Error(`${file.source}: GitHub answered ${answer.status}`);
    const bytes = new Uint8Array(await answer.arrayBuffer());
    if (sha256(bytes) !== file.sha256) {
      throw new Error(`${file.source}: not the file Spoke delivered (its SHA-256 differs)`);
    }
    fetched.push({ file, bytes });
  }
  return fetched;
}

/** Each file under a temporary name first, so a reader never finds half of one. */
function writeAll(fetched: ReadonlyArray<{ file: Wanted; bytes: Uint8Array }>): void {
  for (const { file, bytes } of fetched) {
    mkdirSync(dirname(file.local), { recursive: true });
    const part = `${file.local}.${process.pid}.part`;
    writeFileSync(part, bytes, { mode: 0o644 });
    renameSync(part, file.local);
  }
}

/** A token is one line of visible characters; anything else would be echoed by fetch's header check. */
const TOKEN = /^[\x21-\x7e]+$/;

/** FONTS_TOKEN (the EAS builder), else the member's own `gh` login, else none. */
function credential(): string | undefined {
  const token = process.env.FONTS_TOKEN?.trim();
  if (token && !TOKEN.test(token)) {
    console.error("✖ Saiga: FONTS_TOKEN is not one line of visible characters, so it is not used");
    return undefined;
  }
  if (token) return token;
  try {
    const login = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return login === "" ? undefined : login;
  } catch {
    return undefined;
  }
}

/** pnpm fonts: what is missing, fetched and verified; the exit code. */
async function fetchMissing(list: readonly Wanted[], soft: boolean, get?: Get): Promise<number> {
  const absent = missing(list);
  if (absent.length === 0) {
    console.log(`Saiga ${SAIGA.version}: all ${list.length} files here and verified`);
    return 0;
  }
  const token = credential();
  if (token === undefined) {
    console.log(
      "Saiga: no usable FONTS_TOKEN and no `gh` login, so the app and the panel stay in the system font",
    );
    return 0;
  }
  try {
    const fetched = await fetchAll(absent, token, get);
    writeAll(fetched);
    for (const { file, bytes } of fetched) {
      console.log(`Saiga: ${file.source}, ${bytes.length} bytes, verified`);
    }
    return 0;
  } catch (error) {
    // An error of the platform's may quote what it was given: never the token.
    const why = (error instanceof Error ? error.message : String(error)).replaceAll(
      token,
      "<the token>",
    );
    if (error instanceof NoAccess) {
      console.log(
        `Saiga: ${why}, readable by members of Kuutti ry only; the app and the panel stay in the system font`,
      );
      return 0;
    }
    console.error(
      `✖ Saiga: ${why}; nothing written, the app and the panel stay in the system font`,
    );
    return soft ? 0 : 1;
  }
}

/** The maintainer's: the WOFF2 faces to the panel's bucket, which its CSS names (ADR-052). */
function upload(bucket: string, dir: string): number {
  if (!BUCKET.test(bucket)) {
    console.error(`✖ ${bucket} is not a bucket's name`);
    return 2;
  }
  const faces = wanted(dir).filter(({ source }) => source.startsWith("Saiga/WOFF2/"));
  if (missing(faces).length > 0) {
    console.error("✖ Saiga is not all here: `pnpm fonts` first");
    return 1;
  }
  for (const { local, source } of faces) {
    const key = `fonts/saiga-${SAIGA.version}/${source.slice("Saiga/WOFF2/".length)}`;
    // Immutable: a new release of Saiga is a new folder, so a name never changes what it holds.
    execFileSync(
      "aws",
      [
        "s3",
        "cp",
        local,
        `s3://${bucket}/${key}`,
        "--content-type",
        "font/woff2",
        "--cache-control",
        "public, max-age=31536000, immutable",
      ],
      { stdio: "inherit" },
    );
  }
  console.log(`Saiga: ${faces.length} faces in s3://${bucket}/fonts/saiga-${SAIGA.version}/`);
  return 0;
}

async function selfTest(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "kuutti-fonts-"));
  const fail = (name: string, detail: string): never => {
    console.error(`✖ self-test, ${name}: ${detail}`);
    process.exit(1);
  };
  const logged: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => logged.push(args.join(" "));
  console.error = (...args: unknown[]) => logged.push(args.join(" "));
  const token = "test-token-not-real";
  process.env.FONTS_TOKEN = token;
  try {
    const bytes = new TextEncoder().encode("not a font, a stand-in for one");
    const list: Wanted[] = [
      { source: "Saiga/TTF/A.ttf", local: join(home, "TTF", "A.ttf"), sha256: sha256(bytes) },
      {
        source: "Saiga/WOFF2/A.woff2",
        local: join(home, "WOFF2", "A.woff2"),
        sha256: sha256(bytes),
      },
    ];
    const asked: Array<{ url: string; auth: string | undefined }> = [];
    const serve =
      (status: number, body: Uint8Array = bytes): Get =>
      async (url, init) => {
        asked.push({ url, auth: init.headers.Authorization });
        return new Response(status === 200 ? body : null, { status });
      };

    if ((await fetchMissing(list, false, serve(200))) !== 0) fail("fetch", "exit code");
    if (missing(list).length !== 0) fail("fetch", "files not written");
    const first = asked[0];
    if (!first?.url.endsWith(`/contents/Saiga/TTF/A.ttf?ref=${SAIGA.commit}`)) {
      fail("fetch", `asked ${first?.url}, not the pinned commit`);
    }
    if (first?.auth !== `Bearer ${token}`) fail("fetch", "the token is not in the header");
    asked.length = 0;
    if ((await fetchMissing(list, false, serve(500))) !== 0 || asked.length !== 0) {
      fail("verified files", "fetched again");
    }

    rmSync(home, { recursive: true, force: true });
    const other = new TextEncoder().encode("somebody else's file");
    if ((await fetchMissing(list, false, serve(200, other))) !== 1)
      fail("a changed file", "exit 0");
    if (missing(list).length !== 2) fail("a changed file", "something was written");
    if (!logged.some((line) => line.includes("Saiga/TTF/A.ttf: not the file Spoke delivered"))) {
      fail("a changed file", "the file is not named");
    }
    if ((await fetchMissing(list, true, serve(200, other))) !== 0) fail("--soft", "failed");
    if ((await fetchMissing(list, false, serve(503))) !== 1) fail("a server error", "exit 0");
    for (const status of [401, 403, 404]) {
      if ((await fetchMissing(list, false, serve(status))) !== 0) fail(`${status}`, "failed");
    }
    if (!logged.some((line) => line.includes("members of Kuutti ry only"))) {
      fail("no access", "not said");
    }
    // fetch's own check quotes a header it refuses, the token in it.
    const quoting: Get = async (_url, init) => {
      throw new TypeError(`"${init.headers.Authorization}" is an invalid header value.`);
    };
    if ((await fetchMissing(list, false, quoting)) !== 1) fail("a platform error", "exit 0");
    if (!logged.some((line) => line.includes('"Bearer <the token>" is an invalid'))) {
      fail("a platform error", "not said, or the token not hidden");
    }
    if (logged.some((line) => line.includes(token))) fail("the logs", "they hold the token");
    const pasted = ["secret-first-half", "secret-second-half"];
    process.env.FONTS_TOKEN = pasted.join("\n");
    if ((await fetchMissing(list, false, serve(200))) !== 0) fail("a malformed token", "failed");
    if (!logged.some((line) => line.includes("FONTS_TOKEN is not one line"))) {
      fail("a malformed token", "not said");
    }
    if (logged.some((line) => pasted.some((half) => line.includes(half)))) {
      fail("a malformed token", "the logs hold it");
    }
    if (upload("Not A Bucket", home) !== 2) fail("upload", "took a bad bucket name");
    if (upload("kuutti-staging-admin", home) !== 1) fail("upload", "went ahead without the files");
  } finally {
    console.log = log;
    console.error = error;
    rmSync(home, { recursive: true, force: true });
  }
  console.log(
    "✔ fonts self-test: fetch, the pin, verification, all or none, access, the token never shown, upload",
  );
  process.exit(0);
}

if (process.argv.includes("--self-test")) await selfTest();

if (process.env.GITHUB_ACTIONS === "true") {
  console.error("✖ Saiga never goes to a GitHub runner (ADR-052): this runs on a laptop or on EAS");
  process.exit(2);
}

const list = wanted(saigaDir());
const at = process.argv.indexOf("--upload");
if (at !== -1) {
  process.exit(upload(process.argv[at + 1] ?? "", saigaDir()));
} else if (process.argv.includes("--check")) {
  const absent = missing(list);
  for (const { source } of absent) console.error(`✖ Saiga: ${source} is missing or not Spoke's`);
  if (absent.length === 0) console.log(`Saiga ${SAIGA.version}: all ${list.length} files verified`);
  process.exit(absent.length === 0 ? 0 : 1);
} else {
  process.exit(await fetchMissing(list, process.argv.includes("--soft")));
}
