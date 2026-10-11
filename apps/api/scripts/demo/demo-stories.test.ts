import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertDemoTarget,
  assertStagingProcess,
  DEMO_PERSONAS,
  DEMO_SUBJECT_PREFIX,
  DemoCommandError,
  OLDER_TERMS_VERSION,
  PERSONA_HISTORIES,
  parseDemoCommand,
  personaHetu,
  personaOf,
} from "@kuutti/db/demo";
import { checkCharacter } from "@kuutti/tunnistus-oidc/hetu";
import {
  decideRegistration,
  deriveArtificialIdentity,
  findIdentityByHmac,
  findLiveAccount,
  hmacKeyFromHex,
  NotArtificialError,
  REREGISTER_COOLDOWN_DAYS,
} from "../../src/identity/index.ts";
import {
  captureLogger,
  describe,
  expect,
  TEST_DATABASE_URL,
  type TestContext,
  test,
} from "../../src/test/harness.ts";
import { resetPersonas } from "./reset.ts";
import { giveStories, personaHashes, viaServices } from "./services.ts";

// The stories on staging (#141, ADR-018): where the job may run, and what it
// writes through the service functions, against the database in this
// process, inside a transaction that is rolled back. No bank is involved,
// which is the point of the job.

const DAY_MS = 24 * 60 * 60 * 1000;
const run = promisify(execFile);
const API_DIR = resolve(import.meta.dirname, "../..");
const target = { database: "kuutti", user: "kuutti_app", host: "10.0.1.5", port: 5432 };

async function world(ctx: TestContext) {
  const { logger, lines } = await captureLogger();
  // The pond the histories name, and the default pond (#146): the test database has no seed.
  await ctx.client.query(
    `INSERT INTO ponds (slug, name_nominative, name_inessive) VALUES ('paakaupunkiseutu', 'Pääkaupunkiseutu', 'Pääkaupunkiseudulla')
     ON CONFLICT (slug) DO NOTHING`,
  );
  const hmacKey = hmacKeyFromHex(randomBytes(32).toString("hex"));
  const now = () => new Date();
  const writer = viaServices({ db: ctx.client, logger, now, hmacKey });
  return { logger, lines, hmacKey, now, writer };
}

/** What the callback would decide for the persona today, with the hash the job derived. */
async function loginWouldBe(ctx: TestContext, hmacKey: Buffer, key: string) {
  const persona = DEMO_PERSONAS.find((p) => p.key === key);
  if (!persona) throw new Error(`no persona ${key}`);
  const now = new Date();
  const { hetuHmac } = deriveArtificialIdentity(personaHetu(persona, now), hmacKey, now);
  const identity = await findIdentityByHmac(ctx.client, hetuHmac);
  const liveAccount = identity ? await findLiveAccount(ctx.client, identity.id) : null;
  return { decision: decideRegistration({ identity, liveAccount, now }), identity, now };
}

const markedIdentities = (ctx: TestContext) =>
  ctx.client
    .query<{ n: string }>(
      "SELECT count(*) AS n FROM identity WHERE broker_subject = ANY($1) AND authenticated_at IS NULL",
      [DEMO_PERSONAS.map((p) => `${DEMO_SUBJECT_PREFIX}${p.key}`)],
    )
    .then((r) => Number(r.rows[0]?.n));

describe("where the demo may run on staging", () => {
  test("the process is staging's container and nothing else: the name, and nothing given by hand", () => {
    expect(() => assertStagingProcess({ APP_ENV: "production" })).toThrow(/staging only/);
    expect(() => assertStagingProcess({})).toThrow(/APP_ENV is "unset"/);
    expect(() =>
      assertStagingProcess({ APP_ENV: "staging", DATABASE_URL: "postgres://x" }),
    ).toThrow(/DATABASE_URL given to the process/);
    expect(() =>
      assertStagingProcess({ APP_ENV: "staging", SSM_PARAMETER_PREFIX: "/kuutti/prod/" }),
    ).toThrow(DemoCommandError);
    expect(() =>
      assertStagingProcess({ APP_ENV: "staging", HETU_HMAC_KEY: "0".repeat(64) }),
    ).toThrow(/HETU_HMAC_KEY/);
    expect(() =>
      assertStagingProcess({ APP_ENV: "staging", NODE_ENV: "production" }),
    ).not.toThrow();
  });

  test("staging is a managed server; a managed server is still not development, and production is nobody's", () => {
    expect(() => assertDemoTarget({ ...target, managed: true }, "staging")).not.toThrow();
    expect(() => assertDemoTarget({ ...target, managed: false }, "staging")).toThrow(/managed/);
    expect(() => assertDemoTarget({ ...target, managed: true }, "development")).toThrow(/RDS/);
    expect(parseDemoCommand(["--env", "staging"], "staging").env).toBe("staging");
    expect(() => parseDemoCommand(["--env", "staging"], "production")).toThrow(/production/);
    expect(() => parseDemoCommand([], "production")).toThrow(/production/);
  });

  test("the derivation the job may use refuses a code a person could have", () => {
    const key = hmacKeyFromHex(randomBytes(32).toString("hex"));
    const now = new Date();
    // A valid code whose individual number a person could have: refused before any derivation.
    const personal = `010190-123${checkCharacter("010190", "123")}`;
    expect(() => deriveArtificialIdentity(personal, key, now)).toThrow(NotArtificialError);
    expect(() => deriveArtificialIdentity("010190-123?", key, now)).not.toThrow(NotArtificialError);
    const sanna = personaOf(PERSONA_HISTORIES[0] as (typeof PERSONA_HISTORIES)[number]);
    expect(deriveArtificialIdentity(personaHetu(sanna, now), key, now)).toMatchObject({
      birthYear: 1977,
      birthMonth: 6,
      adult: true,
    });
    expect(personaHashes(key, now).size).toBe(DEMO_PERSONAS.length);
  });

  test("the job refuses production, and a database given by hand, before it reads anything", async ({
    ctx,
  }) => {
    const job = (env: Record<string, string>) =>
      run(process.execPath, ["--import", "tsx", "scripts/demo-stories.ts"], {
        cwd: API_DIR,
        env: { ...process.env, ...env },
      }).then(
        () => ({ code: 0, stderr: "" }),
        (error: { code?: number; stderr?: string }) => ({
          code: error.code ?? -1,
          stderr: error.stderr ?? "",
        }),
      );
    const production = await job({ APP_ENV: "production", DATABASE_URL: TEST_DATABASE_URL });
    expect(production.code).toBe(2);
    expect(production.stderr).toMatch(/refusing: APP_ENV is "production"/);
    const tunnelled = await job({ APP_ENV: "staging", DATABASE_URL: TEST_DATABASE_URL });
    expect(tunnelled.code).toBe(2);
    expect(tunnelled.stderr).toMatch(/DATABASE_URL given to the process/);
    expect(await markedIdentities(ctx)).toBe(0);
  }, 30_000);
});

describe("the stories through the services", () => {
  test("leave each persona where the test bank's login will find it, and a second run changes nothing", async ({
    ctx,
  }) => {
    const { writer, hmacKey } = await world(ctx);
    const first = await giveStories(writer);
    expect(first.map((r) => [r.key, r.login])).toEqual(
      PERSONA_HISTORIES.map((h) => [h.key, "created"]),
    );
    expect(await markedIdentities(ctx)).toBe(PERSONA_HISTORIES.length);

    // What the callback decides on the bed, by the same hash: the story's ending.
    for (const key of ["sanna", "onni", "noa", "kerttu"]) {
      expect((await loginWouldBe(ctx, hmacKey, key)).decision.kind, key).toBe("resume");
    }
    expect((await loginWouldBe(ctx, hmacKey, "tapio")).decision).toEqual({
      kind: "refuse",
      reason: "banned",
    });
    const ilona = await loginWouldBe(ctx, hmacKey, "ilona");
    expect(ilona.decision).toMatchObject({ kind: "refuse", reason: "cooldown" });
    if (ilona.decision.kind === "refuse" && ilona.decision.reason === "cooldown") {
      expect(Math.round((ilona.decision.until.getTime() - ilona.now.getTime()) / DAY_MS)).toBe(
        REREGISTER_COOLDOWN_DAYS,
      );
    }
    // Aino has no history: nothing of her is written until she logs in herself.
    expect((await loginWouldBe(ctx, hmacKey, "aino")).identity).toBeNull();

    const sanna = await loginWouldBe(ctx, hmacKey, "sanna");
    const { rows: accounts } = await ctx.client.query<{
      state: string;
      slug: string | null;
      hide: boolean | null;
      terms: string | null;
    }>(
      `SELECT a.state, p.slug,
              (SELECT (pr.fields->>'hideFromField')::boolean FROM profile pr WHERE pr.account_id = a.id) AS hide,
              (SELECT c.version FROM consent c WHERE c.account_id = a.id AND c.kind = 'terms' LIMIT 1) AS terms
       FROM account a LEFT JOIN ponds p ON p.id = a.pond_id WHERE a.identity_id = $1`,
      [sanna.identity?.id],
    );
    expect(accounts).toEqual([
      { state: "active", slug: "paakaupunkiseutu", hide: null, terms: expect.any(String) },
    ]);
    const noa = await loginWouldBe(ctx, hmacKey, "noa");
    const { rows: noaRows } = await ctx.client.query<{ hide: boolean }>(
      `SELECT (pr.fields->>'hideFromField')::boolean AS hide FROM profile pr
         JOIN account a ON a.id = pr.account_id WHERE a.identity_id = $1`,
      [noa.identity?.id],
    );
    expect(noaRows).toEqual([{ hide: true }]);
    const kerttu = await loginWouldBe(ctx, hmacKey, "kerttu");
    const { rows: kerttuRows } = await ctx.client.query<{ version: string }>(
      `SELECT c.version FROM consent c JOIN account a ON a.id = c.account_id
       WHERE a.identity_id = $1 AND c.kind = 'terms'`,
      [kerttu.identity?.id],
    );
    expect(kerttuRows).toEqual([{ version: OLDER_TERMS_VERSION }]);

    // Again, without a reset: everybody is resumed or told already, and no second account appears.
    const before = await ctx.client.query<{ n: string }>("SELECT count(*) AS n FROM account");
    const second = await giveStories(writer);
    expect(second.map((r) => [r.key, r.login])).toEqual([
      ["sanna", "resumed"],
      ["onni", "resumed"],
      ["noa", "resumed"],
      ["kerttu", "resumed"],
      ["tapio", "already"],
      ["ilona", "already"],
    ]);
    const after = await ctx.client.query<{ n: string }>("SELECT count(*) AS n FROM account");
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  test("the staging reset forgets the personas by their hash, and the stories are given anew", async ({
    ctx,
  }) => {
    const { writer, hmacKey, logger, now } = await world(ctx);
    await giveStories(writer);
    const personas = personaHashes(hmacKey, now());
    expect(await resetPersonas({ db: ctx.client, logger, now, personas })).toEqual({
      identities: PERSONA_HISTORIES.length,
      // Ilona's account was erased by her own story; the other five are live.
      erased: PERSONA_HISTORIES.length - 1,
      objects: 0,
      spared: [],
    });
    expect(await markedIdentities(ctx)).toBe(0);
    for (const history of PERSONA_HISTORIES) {
      expect((await loginWouldBe(ctx, hmacKey, history.key)).identity, history.key).toBeNull();
    }
    const again = await giveStories(writer);
    expect(again.every((r) => r.login === "created")).toBe(true);
  });

  test("the lines carry keys and counts, never a code, a name or whom one seeks", async ({
    ctx,
  }) => {
    const { writer, lines, now } = await world(ctx);
    const results = await giveStories(writer);
    const text = JSON.stringify([lines(), results]);
    for (const persona of DEMO_PERSONAS) {
      expect(text, persona.key).not.toContain(personaHetu(persona, now()));
      expect(text, persona.key).not.toContain(persona.family);
    }
    for (const history of PERSONA_HISTORIES) {
      for (const seeks of history.onboarding?.seeks ?? []) {
        expect(text, history.key).not.toMatch(new RegExp(`"seeks":\\s*\\[?"?${seeks}`));
      }
    }
    expect(text).not.toMatch(/"gender":\s*"(woman|man|non_binary)"/);
  });
});
