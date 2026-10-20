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
import { SanctionList } from "@kuutti/schema";
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
import { countGates } from "../../src/jobs/pond-gate.ts";
import { finnishDay } from "../../src/lib/finnish-day.ts";
import { staffSession } from "../../src/test/account.ts";
import {
  captureLogger,
  describe,
  expect,
  TEST_DATABASE_URL,
  type TestContext,
  test,
} from "../../src/test/harness.ts";
import { giveConversations, giveRounds } from "./histories.ts";
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

/** The bans of an identity, as the panel would list them. */
const bansOf = async (ctx: TestContext, identityId: string | undefined) =>
  (
    await ctx.client.query<{ kind: string; created_by: string | null; lifted_at: Date | null }>(
      "SELECT kind, created_by, lifted_at FROM sanction WHERE identity_id = $1",
      [identityId],
    )
  ).rows;

/** What a report from a conversation writes (#351): the reports, their copies and the blocks. */
const reportsAndBlocks = (ctx: TestContext) =>
  ctx.client
    .query<{ reports: number; copies: number; blocks: number }>(
      `SELECT (SELECT count(*) FROM report)::int AS reports,
              (SELECT count(*) FROM report_message)::int AS copies,
              (SELECT count(*) FROM block)::int AS blocks`,
    )
    .then((r) => r.rows[0]);

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
    const { writer, hmacKey, now } = await world(ctx);
    const first = await giveStories(writer);
    expect(first.map((r) => [r.key, r.login])).toEqual(
      PERSONA_HISTORIES.map((h) => [h.key, "created"]),
    );
    expect(await giveConversations(ctx.client, first, now())).toEqual({
      written: 4,
      already: 0,
      missing: 0,
    });
    expect(await markedIdentities(ctx)).toBe(PERSONA_HISTORIES.length);

    // What the callback decides on the bed, by the same hash: the story's ending.
    for (const key of ["sanna", "onni", "noa", "kerttu"]) {
      expect((await loginWouldBe(ctx, hmacKey, key)).decision.kind, key).toBe("resume");
    }
    const tapio = await loginWouldBe(ctx, hmacKey, "tapio");
    expect(tapio.decision).toEqual({ kind: "refuse", reason: "banned" });
    // His ban is a sanction row by nobody (ADR-024 §10): the panel lists it.
    expect(await bansOf(ctx, tapio.identity?.id)).toEqual([
      { kind: "ban", created_by: null, lifted_at: null },
    ]);
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
      ["helmi", "resumed"],
      ["antti", "resumed"],
      ["ville", "resumed"],
      ["elina", "resumed"],
      ["jussi", "resumed"],
      ["laura", "resumed"],
      ["emmi", "resumed"],
      ["iida", "resumed"],
      ["henna", "resumed"],
      ["katja", "resumed"],
      ["minna", "resumed"],
      ["riikka", "resumed"],
    ]);
    const after = await ctx.client.query<{ n: string }>("SELECT count(*) AS n FROM account");
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    // Nor a second conversation: the resumed accounts have theirs.
    expect(await giveConversations(ctx.client, second, now())).toEqual({
      written: 0,
      already: 4,
      missing: 0,
    });
    // Nor a second ban: Tapio was told already.
    expect(await bansOf(ctx, tapio.identity?.id)).toHaveLength(1);
  });

  test("Tapio's ban is one an admin can lift, and the bank then lets him back in", async ({
    ctx,
  }) => {
    const { writer, hmacKey } = await world(ctx);
    await giveStories(writer);
    const tapio = await loginWouldBe(ctx, hmacKey, "tapio");
    const { rows } = await ctx.client.query<{ id: string }>(
      "SELECT id FROM account WHERE identity_id = $1",
      [tapio.identity?.id],
    );
    const accountId = rows[0]?.id;
    if (!accountId) throw new Error("no account of tapio");
    const admin = await staffSession(ctx.client, "admin");
    const listed = await ctx.app.request(`/admin/accounts/${accountId}/sanctions`, {
      headers: admin.headers,
    });
    expect(listed.status).toBe(200);
    const { items } = SanctionList.parse(await listed.json());
    expect(items).toMatchObject([
      { accountId, kind: "ban", reason: "harassment", createdBy: null, liftedAt: null },
    ]);
    const ban = items[0];
    if (!ban) throw new Error("no ban listed");
    const lifted = await ctx.app.request(`/admin/bans/${ban.id}/lift`, {
      method: "POST",
      headers: admin.headers,
    });
    expect(lifted.status).toBe(200);
    expect((await loginWouldBe(ctx, hmacKey, "tapio")).decision.kind).toBe("resume");
    // Active again, as he was before the story banned him.
    const state = await ctx.client.query<{ state: string; sanctioned_from: string | null }>(
      "SELECT state, sanctioned_from FROM account WHERE id = $1",
      [accountId],
    );
    expect(state.rows).toEqual([{ state: "active", sanctioned_from: null }]);
  });

  test("the staging reset forgets the personas by their hash, and the stories are given anew", async ({
    ctx,
  }) => {
    const { writer, hmacKey, logger, now } = await world(ctx);
    const results = await giveStories(writer);
    await giveConversations(ctx.client, results, now());
    // The stories file no report and set no block: the report's flow files its own (#351).
    expect(await reportsAndBlocks(ctx)).toEqual({ reports: 0, copies: 0, blocks: 0 });
    // What that flow leaves, once per reset (#351): Laura's report of Emmi from
    // their conversation with the copy of its every message, the block both
    // ways, Laura's and then Emmi's back, and the conversation closed by
    // Laura's. Written as the route writes it, which the safety slice's own
    // tests hold; here only the reset's part.
    const [laura, emmi] = ["laura", "emmi"].map(
      (key) => results.find((r) => r.key === key)?.accountId,
    );
    const { rows: theirs } = await ctx.client.query<{ id: string; side: string }>(
      `SELECT p.conversation_id AS id, p.side FROM conversation_participant p
       JOIN conversation_participant q ON q.conversation_id = p.conversation_id AND q.side <> p.side
       WHERE p.account_id = $1 AND q.account_id = $2`,
      [laura, emmi],
    );
    const conversationId = theirs[0]?.id;
    const { rows: filed } = await ctx.client.query<{ id: string }>(
      `INSERT INTO report (reporter_account_id, reported_account_id, source, reason, note,
                           conversation_id)
       VALUES ($1, $2, 'conversation', 'harassment', 'Kysyy osoitettani.', $3) RETURNING id`,
      [laura, emmi, conversationId],
    );
    await ctx.client.query(
      `INSERT INTO report_message (report_id, seq, side, kind, body, photo_id, created_at)
       SELECT $1, seq, (CASE WHEN side = $3::conversation_side THEN 'reporter' ELSE 'reported' END)::report_message_side,
              kind, body, photo_id, created_at
       FROM message WHERE conversation_id = $2`,
      [filed[0]?.id, conversationId, theirs[0]?.side],
    );
    await ctx.client.query(
      `INSERT INTO block (blocker_identity_id, blocked_identity_id)
       SELECT a.identity_id, b.identity_id FROM account a, account b
       WHERE (a.id, b.id) IN (($1::uuid, $2::uuid), ($2::uuid, $1::uuid))`,
      [laura, emmi],
    );
    await ctx.client.query(
      "UPDATE conversation SET closed_at = $2, closed_how = 'block', closed_by = $3 WHERE id = $1",
      [conversationId, now(), theirs[0]?.side],
    );
    expect(await reportsAndBlocks(ctx)).toEqual({ reports: 1, copies: 3, blocks: 2 });
    const personas = personaHashes(hmacKey, now());
    const sanctions = () =>
      ctx.client
        .query<{ n: string }>("SELECT count(*) AS n FROM sanction")
        .then((r) => Number(r.rows[0]?.n));
    expect(await sanctions()).toBe(1);
    expect(await resetPersonas({ db: ctx.client, logger, now, personas })).toEqual({
      identities: PERSONA_HISTORIES.length,
      // Ilona's account was erased by her own story; the others are live.
      erased: PERSONA_HISTORIES.length - 1,
      objects: 0,
      spared: [],
    });
    expect(await markedIdentities(ctx)).toBe(0);
    // Tapio's ban outlived his erasure on the identity (ADR-024 §8) and went with it.
    expect(await sanctions()).toBe(0);
    // Both people of each conversation were erased, so the conversations went too (ADR-031 §5).
    const conversations = await ctx.client.query("SELECT 1 FROM conversation");
    expect(conversations.rows).toEqual([]);
    // And the report with its copy, and the blocks: the report's flow can run again.
    expect(await reportsAndBlocks(ctx)).toEqual({ reports: 0, copies: 0, blocks: 0 });
    for (const history of PERSONA_HISTORIES) {
      expect((await loginWouldBe(ctx, hmacKey, history.key)).identity, history.key).toBeNull();
    }
    const again = await giveStories(writer);
    expect(again.every((r) => r.login === "created")).toBe(true);
    expect(await giveConversations(ctx.client, again, now())).toEqual({
      written: 4,
      already: 0,
      missing: 0,
    });
  });

  test("leave Iida a round for the day, Henna first, who liked her the day before, and a second run changes nothing (#379)", async ({
    ctx,
  }) => {
    const { logger, writer, now } = await world(ctx);
    const results = await giveStories(writer);
    const account = (key: string) => {
      const id = results.find((r) => r.key === key)?.accountId;
      if (!id) throw new Error(`no account for ${key}`);
      return id;
    };
    const cast = ["iida", "henna", "katja", "minna", "riikka"].map(account);
    // The release's faces are no part of a test: two approved photos each, as
    // the loader leaves them where a moderator approves (#142).
    await ctx.client.query(
      `INSERT INTO photo (account_id, key, blurhash, width, height, state, position)
       SELECT id, md5(id::text || n::text), 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 800, 1067, 'approved', n
         FROM unnest($1::uuid[]) AS id, generate_series(0, 1) n`,
      [cast],
    );
    // Before the count nobody is let in, so no gate opens and nothing is built.
    expect(await giveRounds({ db: ctx.client, logger, now }, [])).toEqual({
      opened: 0,
      liked: 0,
      already: 0,
      missing: 1,
      built: 0,
    });
    await countGates({ db: ctx.client, logger, now });
    expect(await giveRounds({ db: ctx.client, logger, now }, results)).toEqual({
      opened: 1,
      liked: 1,
      already: 0,
      missing: 0,
      built: 1,
    });

    const { rows } = await ctx.client.query<{ candidate_id: string; reason: string }>(
      `SELECT e.candidate_id, e.reason FROM rounds r JOIN round_entries e ON e.round_id = r.id
        WHERE r.account_id = $1 AND r.day = $2 ORDER BY e.position`,
      [account("iida"), finnishDay(now())],
    );
    // Henna's like waits first (ADR-037); the other three as anybody's cards, in the order of the soft matches.
    expect(rows[0]).toEqual({ candidate_id: account("henna"), reason: "liked_you" });
    expect(rows.slice(1).map((r) => r.reason)).toEqual([
      "matches_filters",
      "matches_filters",
      "matches_filters",
    ]);
    expect(new Set(rows.slice(1).map((r) => r.candidate_id))).toEqual(
      new Set(["katja", "minna", "riikka"].map(account)),
    );

    // Staging's job runs again without a reset: the round and the like stay as they were.
    expect(await giveRounds({ db: ctx.client, logger, now }, results)).toEqual({
      opened: 0,
      liked: 0,
      already: 1,
      missing: 0,
      built: 0,
    });
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
