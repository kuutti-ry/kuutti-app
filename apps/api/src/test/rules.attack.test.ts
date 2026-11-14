import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Identity, Queryable } from "@kuutti/db";
import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { GateResponse } from "@kuutti/schema";
import { describe, expect, it } from "vitest";
import { attackFails } from "../../../../scripts/lib/attack.ts";
import { createApp } from "../app.ts";
import { decideRegistration, eraseAccount } from "../identity/index.ts";
import { inEachOthersPool, type PoolPerson } from "../matching/index.ts";
import { memoryMediaStore, objectKey, sweepPendingPhotos } from "../media/index.ts";
import { createPush } from "../notifications/index.ts";
import { enrolResearchSubject, removeResearchSubject, track } from "../research/index.ts";
import { signedInAccount, signInAs, withMatchingConfig } from "./account.ts";
import { errorCode } from "./answers.ts";
import { cardShown } from "./cards.ts";
import { conversationBetween } from "./chat.ts";
import { captureLogger, jsonHeaders, testConfig } from "./harness.ts";
import { checked, scriptedModerator } from "./media.ts";
import { openPond, people, pondNamed } from "./people.ts";
import { deviceOf, heldSchedule, memoryPusher } from "./push.ts";
import { rolledBack } from "./rolled-back.ts";

// ADR-002 and #380: the Examples are the executable input, not a second
// table pasted into TypeScript. Keep this reader deliberately limited to
// our one-outline, one-table attack files; an unfamiliar shape fails closed.
type Example = { case: string; violation: string };
type Rule = (control: boolean) => boolean | Promise<boolean>;

function examples(source: string, name: string, cases: readonly string[]): Example[] {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const outlines = lines.filter((line) => /^Scenario(?: Outline)?:/.test(line));
  if (outlines.length !== 1 || outlines[0] !== `Scenario Outline: ${name}`)
    throw new Error("one named outline required");
  const starts = lines.flatMap((line, i) => (line === "Examples:" ? [i] : []));
  if (starts.length !== 1) throw new Error("one Examples table required");
  const start = starts[0];
  if (start === undefined) throw new Error("Examples missing");
  const table = lines.slice(start + 1);
  if (table.some((line) => !line.startsWith("|") || !line.endsWith("|")))
    throw new Error("only Examples rows may follow the header");
  const cells = table.map((line) =>
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim()),
  );
  if (JSON.stringify(cells.shift()) !== JSON.stringify(["case", "violation"]))
    throw new Error("Examples header must be case | violation");
  const rows = cells.map((row) => {
    if (row.length !== 2 || !row[0] || !row[1])
      throw new Error("each Example needs a case and violation");
    return { case: row[0], violation: row[1] };
  });
  if (
    new Set(rows.map((row) => row.case)).size !== rows.length ||
    new Set(rows.map((row) => row.violation)).size !== rows.length
  )
    throw new Error("duplicate Example");
  if (rows.length !== cases.length || rows.some((row) => !cases.includes(row.case)))
    throw new Error("Examples and executable cases differ");
  return rows;
}

function rules(slice: string, name: string, cases: Record<string, Rule>) {
  const source = readFileSync(
    resolve(import.meta.dirname, "../../../../features", slice, "attacks.feature"),
    "utf8",
  );
  const rows = examples(source, name, Object.keys(cases));
  const run = (row: Example, control: boolean) => {
    const rule = cases[row.case];
    if (!rule) throw new Error(`unbound Example: ${row.case}`);
    return rule(control);
  };
  it.each(rows)("control: $violation", async (row) => expect(await run(row, true)).toBe(true));
  it.each(rows)("attack: $violation", async (row) =>
    attackFails(row.violation, {
      attempt: () => run(row, false),
      control: () => run(row, true),
      succeeds: (seen) => expect(seen).toBe(true),
    }),
  );
}

describe("the attack Examples are exhaustively bound", () => {
  const source =
    "Scenario Outline: bound\nExamples:\n| case | violation |\n| first | forbidden result |";
  it("reads the actual row and its assertion name", () => {
    expect(examples(source, "bound", ["first"])).toEqual([
      { case: "first", violation: "forbidden result" },
    ]);
  });
  it.each([
    source.replace("case | violation", "case | result"),
    source.replace("| first | forbidden result |", ""),
    `${source}\n| first | another result |`,
    `${source}\n| second | forbidden result |`,
    source.replace("first", "unknown"),
    source.replace("forbidden result", ""),
    `${source}\nExamples:\n| case | violation |`,
    source.replace("Scenario Outline: bound", "Scenario: bound"),
  ])("refuses missing, duplicate or unbound data %#", (invalid) => {
    expect(() => examples(invalid, "bound", ["first"])).toThrow();
  });
});

const AT = new Date("2026-10-16T09:00:00.000Z");
const DAY = 86_400_000;
const CLIENT_ID = "00000000-0000-4000-8000-000000000381";

function identity(): Identity {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    hetuHmac: "a".repeat(64),
    standing: "ok",
    standingChangedAt: null,
    brokerSubject: null,
    brokerSessionIndex: null,
    brokerTokenId: null,
    authenticatedAt: null,
    acr: null,
    amr: null,
    deletionCount: 0,
    reregisterAfter: null,
    refusedAttempts: 0,
    suspensionEndsAt: null,
    createdAt: AT,
  };
}

describe("Registration attacks cannot discard a standing restriction", () => {
  rules(
    "identity",
    "Registration attacks cannot discard a standing restriction",
    Object.fromEntries(
      ["banned", "suspended", "cooldown"].map((restriction) => [
        restriction,
        (control: boolean) => {
          const person = identity();
          if (!control) {
            if (restriction === "banned" || restriction === "suspended")
              person.standing = restriction;
            else person.reregisterAfter = new Date(AT.getTime() + DAY);
          }
          const decision = decideRegistration({ identity: person, liveAccount: null, now: AT });
          if (decision.kind !== "create_account")
            expect(decision).toMatchObject({ kind: "refuse", reason: restriction });
          return decision.kind === "create_account";
        },
      ]),
    ),
  );
});

function poolPerson(identityId: string): PoolPerson {
  return {
    identityId,
    gender: "woman",
    seeks: ["woman"],
    ageWindow: { min: 25, max: 40 },
    age: 30,
    intent: "open_to_either",
    home: { x: 0, y: 0, edges: { nearby: 5, close: 15, around: 50 } },
    blocks: new Set(),
    fields: {},
    dealBreakers: [],
  };
}

describe("Pool attacks cannot ignore the other person's hard filters", () => {
  rules(
    "matching",
    "Pool attacks cannot ignore the other person's hard filters",
    Object.fromEntries(
      ["reverse_age", "reverse_gender", "dance_intent"].map((filter) => [
        filter,
        (control: boolean) => {
          const a = poolPerson("a");
          const b = poolPerson("b");
          if (!control) {
            if (filter === "reverse_age") b.ageWindow = { min: 31, max: 40 };
            if (filter === "reverse_gender") b.seeks = ["man"];
            if (filter === "dance_intent") b.intent = "dance_partner";
          }
          return inEachOthersPool(a, b);
        },
      ]),
    ),
  );
});

describe("Gate attacks cannot announce matching before its prerequisites", () => {
  rules(
    "pond",
    "Gate attacks cannot announce matching before its prerequisites",
    Object.fromEntries(
      ["closed_pond", "missing_photos", "missing_consent"].map((missing) => [
        missing,
        (control: boolean) =>
          rolledBack(async (db) => {
            const pond = await pondNamed(db, `attack-gate-${missing}`);
            if (control || missing !== "closed_pond") await openPond(db, pond);
            const [accountId] = await people(db, pond, 1, {
              complete: true,
              gender: "woman",
              consented: true,
            });
            if (!accountId) throw new Error("gate account not written");
            if (!control && missing === "missing_photos")
              await db.query("DELETE FROM photo WHERE account_id = $1", [accountId]);
            if (!control && missing === "missing_consent")
              await db.query(
                "DELETE FROM consent WHERE account_id = $1 AND kind = 'special_category'",
                [accountId],
              );
            const caller = await signInAs(db, accountId);
            const { logger } = await captureLogger();
            const app = createApp({ db, logger, config: testConfig(), now: () => AT });
            const response = await app.request("/gate", { headers: caller.headers });
            expect(response.status).toBe(200);
            const { state } = GateResponse.parse(await response.json());
            if (state !== "open")
              expect(state).toBe(missing === "closed_pond" ? "closed" : "incomplete");
            return state === "open";
          }),
      ]),
    ),
  );
});

async function accepted(response: Response, success: number, refusal: number, code: string) {
  if (response.status === success) return true;
  expect(response.status).toBe(refusal);
  expect(await errorCode(response)).toBe(code);
  return false;
}

describe("Card safety attacks cannot invent a person the caller was shown", () => {
  rules(
    "safety",
    "Card safety attacks cannot invent a person the caller was shown",
    Object.fromEntries(
      ["unseen_block", "unseen_report", "self_block"].map((kind) => [
        kind,
        (control: boolean) =>
          rolledBack(async (db) => {
            const caller = await signedInAccount(db, "safety-attack-caller");
            const target = await signedInAccount(db, "safety-attack-target");
            const accountId =
              !control && kind === "self_block" ? caller.accountId : target.accountId;
            if (control) await cardShown(db, caller.accountId, target.accountId, AT);
            const { logger } = await captureLogger();
            const app = createApp({ db, logger, config: testConfig(), now: () => AT });
            const report = kind === "unseen_report";
            const response = await app.request(report ? "/reports" : "/blocks", {
              method: "POST",
              headers: jsonHeaders(caller.headers),
              body: JSON.stringify({ accountId, ...(report ? { reason: "other" } : {}) }),
            });
            return accepted(response, 204, 404, "not_found");
          }),
      ]),
    ),
  );
});

describe("Conversation attacks cannot write past a close or block", () => {
  rules(
    "chat",
    "Conversation attacks cannot write past a close or block",
    Object.fromEntries(
      ["closed_message", "blocked_message", "closed_share"].map((kind) => [
        kind,
        (control: boolean) =>
          rolledBack(async (db) => {
            const caller = await signedInAccount(db, "chat-attack-caller");
            const target = await signedInAccount(db, "chat-attack-target");
            const id = await conversationBetween(db, caller.accountId, target.accountId, {
              openedAt: new Date(AT.getTime() - DAY),
            });
            const { logger } = await captureLogger();
            const app = createApp({ db, logger, config: testConfig(), now: () => AT });
            if (kind === "closed_share") {
              const saved = await app.request("/contacts/phone", {
                method: "PUT",
                headers: jsonHeaders(caller.headers),
                body: JSON.stringify({ value: "+358401234567" }),
              });
              expect(saved.status).toBe(200);
            }
            if (!control) {
              const closed = await app.request(
                `/conversations/${id}/${kind === "blocked_message" ? "block" : "unmatch"}`,
                { method: "POST", headers: target.headers },
              );
              expect(closed.status).toBe(204);
            }
            const sharing = kind === "closed_share";
            const response = await app.request(
              `/conversations/${id}/${sharing ? "contacts/phone" : "messages"}`,
              {
                method: "POST",
                headers: jsonHeaders(caller.headers),
                ...(!sharing
                  ? {
                      body: JSON.stringify({
                        clientId: CLIENT_ID,
                        body: "This message should reach an open conversation.",
                      }),
                    }
                  : {}),
              },
            );
            return accepted(response, sharing ? 200 : 201, 409, "conversation_closed");
          }),
      ]),
    ),
  );
});

describe("Photo check attacks cannot turn a definite refusal into approval", () => {
  rules(
    "media",
    "Photo check attacks cannot turn a definite refusal into approval",
    Object.fromEntries(
      ["nudity", "no_face", "several_faces"].map((kind) => [
        kind,
        (control: boolean) =>
          rolledBack(async (db) => {
            const [accountId] = await people(db, null, 1);
            if (!accountId) throw new Error("photo owner not written");
            const key = "e".repeat(64);
            const written = await db.query<{ id: string }>(
              `INSERT INTO photo (account_id, key, blurhash, width, height, state, position, created_at)
         VALUES ($1, $2, 'LKO2?U%2Tw=w', 800, 1067, 'pending', 0, $3) RETURNING id`,
              [accountId, key, new Date(AT.getTime() - DAY)],
            );
            const photoId = written.rows[0]?.id;
            if (!photoId) throw new Error("pending photo not written");
            const store = memoryMediaStore();
            await store.put(objectKey(key, "card"), new Uint8Array([1, 2, 3]), "image/webp");
            const inspection = control
              ? checked([])
              : kind === "nudity"
                ? checked([["Explicit Nudity", 99]])
                : checked([], kind === "no_face" ? [] : [99, 99]);
            const moderator = scriptedModerator(inspection);
            const { logger } = await captureLogger();
            expect(
              await sweepPendingPhotos({ db, logger, now: () => AT, moderator, store }),
            ).toEqual({ rechecked: 1, failed: 0 });
            expect(moderator.seen).toEqual([3]);
            const result = await db.query<{ state: string }>(
              "SELECT state FROM photo WHERE id = $1",
              [photoId],
            );
            const state = result.rows[0]?.state;
            if (state !== "approved") expect(state).toBe("rejected");
            return state === "approved";
          }),
      ]),
    ),
  );
});

describe("Erasure attacks cannot keep the person's private rows", () => {
  rules(
    "erasure",
    "Erasure attacks cannot keep the person's private rows",
    Object.fromEntries(
      ["profile", "session", "contact"].map((table) => [
        table,
        (control: boolean) =>
          rolledBack(async (db) => {
            const [accountId] = await people(db, null, 1, { complete: true });
            if (!accountId) throw new Error("erasure account not written");
            await signInAs(db, accountId);
            await db.query(
              "INSERT INTO contact (account_id, kind, value) VALUES ($1, 'phone', '+358401234567')",
              [accountId],
            );
            const { logger } = await captureLogger();
            if (!control) await eraseAccount({ db, logger, now: () => AT }, accountId);
            // The table is one of this closed list, never request data.
            const left = await db.query(`SELECT 1 FROM ${table} WHERE account_id = $1`, [
              accountId,
            ]);
            return left.rows.length > 0;
          }),
      ]),
    ),
  );
});

describe("Push attacks cannot bypass the person's delivery restrictions", () => {
  rules(
    "notifications",
    "Push attacks cannot bypass the person's delivery restrictions",
    Object.fromEntries(
      ["quiet_hours", "switched_off", "expired_session"].map((kind) => [
        kind,
        (control: boolean) =>
          rolledBack(async (db) => {
            const [accountId] = await people(db, null, 1, { complete: true });
            if (!accountId) throw new Error("push account not written");
            await withMatchingConfig(db, { push_quiet_from_hour: 22, push_quiet_to_hour: 8 });
            const device = await deviceOf(db, accountId, {
              at: AT,
              ...(!control && kind === "expired_session"
                ? { expiresAt: new Date(AT.getTime() - 1) }
                : {}),
            });
            if (!control && kind === "switched_off")
              await db.query(
                "INSERT INTO notification_preference (account_id, kind, enabled) VALUES ($1, 'match', false)",
                [accountId],
              );
            const { logger, lines } = await captureLogger();
            const pusher = memoryPusher();
            const push = createPush({
              db,
              logger,
              pusher,
              now: () =>
                !control && kind === "quiet_hours" ? new Date("2026-10-16T20:00:00.000Z") : AT,
              online: () => false,
              schedule: heldSchedule().schedule,
              pause: async () => {},
            });
            push.match({ accountId });
            await push.settled();
            expect(lines().filter((line) => Number(line.level) >= 40)).toEqual([]);
            return pusher.sent().some((message) => message.to === device.token);
          }),
      ]),
    ),
  );
});

async function enrolled(db: Queryable, accountId: string) {
  const version = CONSENT_VERSIONS.research;
  if (!version) throw new Error("research consent version missing");
  expect(await enrolResearchSubject(db, accountId, version, AT)).toBe("enrolled");
}

describe("Research attacks cannot record without a live consent mapping", () => {
  rules(
    "research",
    "Research attacks cannot record without a live consent mapping",
    Object.fromEntries(
      ["no_consent", "withdrawn", "erased"].map((kind) => [
        kind,
        (control: boolean) =>
          rolledBack(async (db) => {
            const [accountId] = await people(db, null, 1, { complete: true });
            if (!accountId) throw new Error("research account not written");
            const { logger } = await captureLogger();
            if (control || kind !== "no_consent") await enrolled(db, accountId);
            if (!control && kind === "withdrawn")
              expect(await removeResearchSubject(db, accountId)).toBe(1);
            if (!control && kind === "erased")
              await eraseAccount({ db, logger, now: () => AT }, accountId);
            const before = await db.query<{ n: string }>("SELECT count(*) AS n FROM events");
            const result = await track({ db, logger, now: () => AT }, accountId, "profile_saved", {
              complete: true,
              approvedPhotos: 3,
            });
            if (!result.recorded) expect(result.reason).toBe("no_consent");
            const after = await db.query<{ n: string }>("SELECT count(*) AS n FROM events");
            return Number(after.rows[0]?.n) > Number(before.rows[0]?.n);
          }),
      ]),
    ),
  );
});
