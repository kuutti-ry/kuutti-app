import type { Queryable } from "@kuutti/db";
import { AccountEmailResponse, ErrorResponse } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { AppError } from "../lib/errors.ts";
import { type Mailer, MailFailed, type MailMessage } from "../lib/mail.ts";
import { dayWindow } from "../media/index.ts";
import { signedInAccount } from "../test/account.ts";
import { exportOf } from "../test/export.ts";
import {
  captureLogger,
  englishT,
  type LogLine,
  type TestContext,
  test,
  testConfig,
} from "../test/harness.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import {
  codeOf,
  confirmEmailCode,
  type EmailDeps,
  hashCode,
  readEmail,
  sendEmailCode,
  setAccountEmail,
} from "./email.ts";

// features/identity/email-confirmation.feature (#385, ADR-043): the optional
// e-mail confirmed by six digits sent to it. Real Postgres in a rolled-back
// transaction; the mail goes to a recording double, never the network, and
// the code is read back from the message as the person would read it. Two
// phones at once race on committed rows of a database of their own.

const MINUTE = 60_000;
const ADDRESS = "aino.confirm@example.fi";
const OTHER = "aino.second@example.fi";

async function appWith(ctx: TestContext, options: { mailer?: Mailer | null; at?: Date } = {}) {
  const { logger, lines } = await captureLogger();
  const sent: MailMessage[] = [];
  const recording: Mailer = {
    send: async (message) => {
      sent.push(message);
    },
  };
  const mailer = options.mailer === undefined ? recording : options.mailer;
  const clock = { at: options.at ?? new Date() };
  const app = createApp({
    config: testConfig(),
    logger,
    db: ctx.client,
    now: () => clock.at,
    ...(mailer ? { mailer } : {}),
  });
  return { app, logs: lines, sent, clock };
}
type App = Awaited<ReturnType<typeof appWith>>["app"];
type Headers = Record<string, string>;

const call = (app: App, headers: Headers, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { ...headers, "content-type": "application/json", "accept-language": "en" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const setAddress = (app: App, headers: Headers, email: string) =>
  call(app, headers, "PUT", "/account/email", { email });
const sendCode = (app: App, headers: Headers) => call(app, headers, "POST", "/account/email/code");
const confirm = (app: App, headers: Headers, code: string) =>
  call(app, headers, "POST", "/account/email/confirm", { code });
const stateOf = async (app: App, headers: Headers) =>
  AccountEmailResponse.parse(await (await call(app, headers, "GET", "/account/email")).json());
const errorOf = async (res: Response) => ErrorResponse.parse(await res.json()).error;
/** The six digits as the person reads them in the message. */
const codeIn = (message: MailMessage | undefined) =>
  /\b(\d{6})\b/.exec(message?.text ?? "")?.[1] ?? "";
/** A code that is not the one sent: the next one up, wrapping at a million. */
const wrongFor = (code: string) => codeOf((Number(code) + 1) % 1_000_000);

/**
 * Whether the log lines hold the code: six digits with no letter or digit on
 * either side, so a value or a word of one. Pino's time, pid and hostname go
 * first, since they carry nothing of a request; six digits occur in those by
 * chance, and inside a uuid's hex, and a search that counted them would fail
 * at random.
 */
function logsHoldCode(lines: LogLine[], code: string): boolean {
  const own = lines.map(({ time: _time, pid: _pid, hostname: _hostname, ...rest }) => rest);
  return new RegExp(`(?<![0-9A-Za-z])${code}(?![0-9A-Za-z])`).test(JSON.stringify(own));
}

const countIn = async (db: Queryable, table: "email_code" | "email_send", accountId: string) =>
  Number(
    (
      await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE account_id = $1`, [
        accountId,
      ])
    ).rows[0]?.n,
  );
const rowsOf = (ctx: TestContext, table: "email_code" | "email_send", accountId: string) =>
  countIn(ctx.client, table, accountId);

describe("confirming the optional e-mail", () => {
  test("A code sent to the address confirms it", async ({ ctx }) => {
    const { app, sent, clock, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const set = await setAddress(app, a.headers, ADDRESS);
    expect(set.status).toBe(200);
    expect(AccountEmailResponse.parse(await set.json())).toEqual({
      email: ADDRESS,
      confirmed: false,
      codeExpiresAt: null,
    });
    // Setting sends nothing: the app asks for the code.
    expect(sent).toEqual([]);

    const asked = await sendCode(app, a.headers);
    expect(asked.status).toBe(200);
    expect(AccountEmailResponse.parse(await asked.json())).toEqual({
      email: ADDRESS,
      confirmed: false,
      codeExpiresAt: new Date(clock.at.getTime() + 30 * MINUTE).toISOString(),
    });
    expect(sent).toHaveLength(1);
    const message = sent[0];
    expect(message?.to).toBe(ADDRESS);
    expect(message?.subject).toBe("Your code for Kuutti");
    const code = codeIn(message);
    expect(code).toMatch(/^\d{6}$/);
    expect(message?.text).toBe(
      `Your code is ${code}. It works for 30 minutes.\n\nSomeone added this address in the Kuutti app as a way to stay in touch. If that was not you, you can ignore this message.\n\nKuutti ry`,
    );
    // Only the hash is stored, with the account's id in front.
    const stored = await ctx.client.query<{ code_hash: string }>(
      "SELECT code_hash FROM email_code WHERE account_id = $1",
      [a.accountId],
    );
    expect(stored.rows).toEqual([{ code_hash: hashCode(a.accountId, code) }]);
    expect(stored.rows[0]?.code_hash).not.toBe(code);

    const confirmed = await confirm(app, a.headers, code);
    expect(confirmed.status).toBe(200);
    expect(AccountEmailResponse.parse(await confirmed.json())).toEqual({
      email: ADDRESS,
      confirmed: true,
      codeExpiresAt: null,
    });
    expect(await rowsOf(ctx, "email_code", a.accountId)).toBe(0);
    // Typed again (a second tap): the same answer, nothing changes.
    expect((await confirm(app, a.headers, code)).status).toBe(200);
    expect(await stateOf(app, a.headers)).toMatchObject({ confirmed: true });

    // Neither the address nor the code reaches a log line; the lines say what happened.
    expect(JSON.stringify(logs())).not.toContain("confirm@");
    expect(logsHoldCode(logs(), code)).toBe(false);
    expect(logs().map((l) => l.msg)).toEqual(
      expect.arrayContaining(["email set", "email code sent", "email confirmed"]),
    );
  });

  test("A new address is unconfirmed, and the code waiting for the old one stops working", async ({
    ctx,
  }) => {
    const { app, sent } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await setAddress(app, a.headers, ADDRESS);
    await sendCode(app, a.headers);
    expect((await confirm(app, a.headers, codeIn(sent[0]))).status).toBe(200);
    // A code waits for nothing once confirmed; a second address starts over.
    await setAddress(app, a.headers, OTHER);
    expect(await stateOf(app, a.headers)).toEqual({
      email: OTHER,
      confirmed: false,
      codeExpiresAt: null,
    });
    await sendCode(app, a.headers);
    const forOther = codeIn(sent[1]);
    expect(sent[1]?.to).toBe(OTHER);
    // Changed again before typing it: that code goes with the address it was for.
    await setAddress(app, a.headers, ADDRESS);
    const res = await confirm(app, a.headers, forOther);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("email_code_none");
    expect(await stateOf(app, a.headers)).toMatchObject({ email: ADDRESS, confirmed: false });
  });

  test("The same address again changes nothing", async ({ ctx }) => {
    const { app, sent, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await setAddress(app, a.headers, ADDRESS);
    await sendCode(app, a.headers);
    await confirm(app, a.headers, codeIn(sent[0]));
    const again = await setAddress(app, a.headers, ADDRESS);
    expect(again.status).toBe(200);
    expect(AccountEmailResponse.parse(await again.json())).toMatchObject({ confirmed: true });
    expect(sent).toHaveLength(1);
    expect(
      logs()
        .filter((l) => l.msg === "email set")
        .map((l) => l.changed),
    ).toEqual([true, false]);
  });

  test("A wrong code counts a try, and the third spends it", async ({ ctx }) => {
    const { app, sent } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await setAddress(app, a.headers, ADDRESS);
    await sendCode(app, a.headers);
    const code = codeIn(sent[0]);
    const wrong = wrongFor(code);
    for (const left of [2, 1]) {
      const res = await confirm(app, a.headers, wrong);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("email_code_wrong");
      // Still waiting between the tries, each one counted.
      expect((await stateOf(app, a.headers)).codeExpiresAt).not.toBeNull();
      const stored = await ctx.client.query<{ attempts: number }>(
        "SELECT attempts FROM email_code WHERE account_id = $1",
        [a.accountId],
      );
      expect(stored.rows).toEqual([{ attempts: 3 - left }]);
    }
    const third = await confirm(app, a.headers, wrong);
    expect(third.status).toBe(409);
    expect((await errorOf(third)).code).toBe("email_code_spent");
    expect(await rowsOf(ctx, "email_code", a.accountId)).toBe(0);
    // The right code comes too late.
    const late = await confirm(app, a.headers, code);
    expect(late.status).toBe(409);
    expect((await errorOf(late)).code).toBe("email_code_none");
    expect(await stateOf(app, a.headers)).toMatchObject({ confirmed: false, codeExpiresAt: null });
  });

  test("A code typed after its thirty minutes has expired", async ({ ctx }) => {
    const { app, sent, clock } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await setAddress(app, a.headers, ADDRESS);
    await sendCode(app, a.headers);
    const code = codeIn(sent[0]);
    const sentAt = clock.at;
    // A minute before its end it still works on the read; at its end it is gone.
    clock.at = new Date(sentAt.getTime() + 29 * MINUTE);
    expect((await stateOf(app, a.headers)).codeExpiresAt).not.toBeNull();
    clock.at = new Date(sentAt.getTime() + 30 * MINUTE);
    expect((await stateOf(app, a.headers)).codeExpiresAt).toBeNull();
    const res = await confirm(app, a.headers, code);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("email_code_expired");
    expect(await rowsOf(ctx, "email_code", a.accountId)).toBe(0);
    expect((await errorOf(await confirm(app, a.headers, code))).code).toBe("email_code_none");
  });

  test("A new code replaces the one that waits", async ({ ctx }) => {
    const { app, sent, clock } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await setAddress(app, a.headers, ADDRESS);
    await sendCode(app, a.headers);
    // A wrong try on the first, then a second code five minutes later.
    expect((await confirm(app, a.headers, wrongFor(codeIn(sent[0])))).status).toBe(400);
    clock.at = new Date(clock.at.getTime() + 5 * MINUTE);
    const second = await sendCode(app, a.headers);
    expect(AccountEmailResponse.parse(await second.json()).codeExpiresAt).toBe(
      new Date(clock.at.getTime() + 30 * MINUTE).toISOString(),
    );
    const next = codeIn(sent[1]);
    // The first stopped working (unless the two happen to be equal), and the
    // second's tries start over: two wrong ones leave it waiting, where the
    // first's count would have spent it.
    const wrong = wrongFor(next);
    const first = codeIn(sent[0]);
    expect((await confirm(app, a.headers, first === next ? wrong : first)).status).toBe(400);
    expect((await confirm(app, a.headers, wrong)).status).toBe(400);
    expect((await confirm(app, a.headers, next)).status).toBe(200);
  });

  test("Five codes a day, the sixth refused until midnight", async ({ ctx }) => {
    const { app, sent, clock, logs } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await setAddress(app, a.headers, ADDRESS);
    for (let i = 0; i < 5; i += 1) expect((await sendCode(app, a.headers)).status).toBe(200);
    const sixth = await sendCode(app, a.headers);
    expect(sixth.status).toBe(429);
    expect((await errorOf(sixth)).code).toBe("email_code_budget_exceeded");
    const day = dayWindow(clock.at);
    const wait = Math.max(1, Math.ceil((day.end.getTime() - clock.at.getTime()) / 1000));
    expect(sixth.headers.get("retry-after")).toBe(String(wait));
    expect(sent).toHaveLength(5);
    expect(await rowsOf(ctx, "email_send", a.accountId)).toBe(5);
    expect(logs().some((l) => l.msg === "email code refused" && l.used === 5)).toBe(true);
    // Clearing the address and setting it again does not reset the day.
    await call(app, a.headers, "DELETE", "/account/email");
    await setAddress(app, a.headers, ADDRESS);
    expect((await sendCode(app, a.headers)).status).toBe(429);
    // The next Finnish day: a code is sent, and the earlier day's sends are gone.
    clock.at = new Date(day.end.getTime() + MINUTE);
    expect((await sendCode(app, a.headers)).status).toBe(200);
    expect(await rowsOf(ctx, "email_send", a.accountId)).toBe(1);
  });

  test("A send that fails counts nothing and leaves no code", async ({ ctx }) => {
    // SES names the address in its messages: the failure carries the name and
    // status only. The message is kept as it was handed over, so the log can
    // be searched for the code that never arrived.
    const attempted: MailMessage[] = [];
    const failing: Mailer = {
      send: async (message) => {
        attempted.push(message);
        throw new MailFailed("MessageRejected", 400);
      },
    };
    const { app, logs } = await appWith(ctx, { mailer: failing });
    const a = await signedInAccount(ctx.client);
    await setAddress(app, a.headers, ADDRESS);
    const res = await sendCode(app, a.headers);
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe("mail_unavailable");
    expect(await rowsOf(ctx, "email_code", a.accountId)).toBe(0);
    expect(await rowsOf(ctx, "email_send", a.accountId)).toBe(0);
    expect(await stateOf(app, a.headers)).toMatchObject({ confirmed: false, codeExpiresAt: null });
    expect(logs().find((l) => l.msg === "email code not sent")).toMatchObject({
      reason: "MessageRejected",
      status: 400,
    });
    expect(attempted).toHaveLength(1);
    const code = codeIn(attempted[0]);
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(logs())).not.toContain("confirm@");
    expect(logsHoldCode(logs(), code)).toBe(false);
  });

  test("Where no mail is sent, asking for a code answers so", async ({ ctx }) => {
    const { app } = await appWith(ctx, { mailer: null });
    const a = await signedInAccount(ctx.client);
    await setAddress(app, a.headers, ADDRESS);
    const res = await sendCode(app, a.headers);
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe("mail_unavailable");
    expect(await rowsOf(ctx, "email_send", a.accountId)).toBe(0);
  });

  test("No code for no address, and none for a confirmed one", async ({ ctx }) => {
    const { app, sent } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const none = await sendCode(app, a.headers);
    expect(none.status).toBe(409);
    expect((await errorOf(none)).code).toBe("email_none");
    const typed = await confirm(app, a.headers, "123456");
    expect(typed.status).toBe(409);
    expect((await errorOf(typed)).code).toBe("email_none");
    await setAddress(app, a.headers, ADDRESS);
    // An address, but no code asked for yet.
    expect((await errorOf(await confirm(app, a.headers, "123456"))).code).toBe("email_code_none");
    await sendCode(app, a.headers);
    await confirm(app, a.headers, codeIn(sent[0]));
    const confirmed = await sendCode(app, a.headers);
    expect(confirmed.status).toBe(409);
    expect((await errorOf(confirmed)).code).toBe("email_confirmed");
    expect(sent).toHaveLength(1);
    expect(await rowsOf(ctx, "email_send", a.accountId)).toBe(1);
  });

  test("The confirmation is exported, and goes with the address and the account", async ({
    ctx,
  }) => {
    const { app, sent, clock } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await setAddress(app, a.headers, ADDRESS);
    await sendCode(app, a.headers);
    await confirm(app, a.headers, codeIn(sent[0]));
    const exported = await exportOf(app, a.headers);
    expect(exported.account).toMatchObject({
      email: ADDRESS,
      emailConfirmedAt: clock.at.toISOString(),
    });
    // Removed and set again: unconfirmed, as any new address.
    expect((await call(app, a.headers, "DELETE", "/account/email")).status).toBe(204);
    expect(await stateOf(app, a.headers)).toEqual({
      email: null,
      confirmed: false,
      codeExpiresAt: null,
    });
    await setAddress(app, a.headers, ADDRESS);
    expect(await stateOf(app, a.headers)).toMatchObject({ confirmed: false });
    expect((await exportOf(app, a.headers)).account.emailConfirmedAt).toBeNull();
    // A code waits and a send is counted; erasure takes both, and the tombstone keeps neither the address nor its confirmation.
    await sendCode(app, a.headers);
    const deleted = await call(app, a.headers, "POST", "/account/delete", { confirm: true });
    expect(deleted.status).toBe(204);
    expect(await rowsOf(ctx, "email_code", a.accountId)).toBe(0);
    expect(await rowsOf(ctx, "email_send", a.accountId)).toBe(0);
    const row = await ctx.client.query(
      "SELECT email, email_confirmed_at FROM account WHERE id = $1",
      [a.accountId],
    );
    expect(row.rows).toEqual([{ email: null, email_confirmed_at: null }]);
  });

  test("the message follows the request's language", async ({ ctx }) => {
    const { app, sent } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await setAddress(app, a.headers, ADDRESS);
    const res = await app.request("/account/email/code", {
      method: "POST",
      headers: { ...a.headers, "accept-language": "fi" },
    });
    expect(res.status).toBe(200);
    expect(sent[0]?.subject).toBe("Koodisi Kuuttiin");
    expect(sent[0]?.text).toMatch(/^Koodisi on \d{6}\. Se on voimassa 30 minuutin ajan\./);
    expect(sent[0]?.text.endsWith("\n\nKuutti ry")).toBe(true);
  });

  test("a code that is not six digits is refused before anything is read", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    for (const body of [
      { code: "12345" },
      { code: "1234567" },
      { code: "12345a" },
      { code: " 123456" },
      { code: 123456 },
      { code: "123456", extra: 1 },
      {},
    ]) {
      const res = await call(app, a.headers, "POST", "/account/email/confirm", body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
      expect((await errorOf(res)).code).toBe("validation_failed");
    }
  });

  test("the confirmation routes need a session and act on the caller's own address only", async ({
    ctx,
  }) => {
    const { app, sent } = await appWith(ctx);
    for (const path of ["/account/email/code", "/account/email/confirm"]) {
      expect((await app.request(path, { method: "POST" })).status).toBe(401);
    }
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    await setAddress(app, a.headers, ADDRESS);
    await sendCode(app, a.headers);
    const code = codeIn(sent[0]);
    // B has no address, so A's code confirms nothing of B's, and A's stays waiting.
    expect((await errorOf(await confirm(app, b.headers, code))).code).toBe("email_none");
    await setAddress(app, b.headers, ADDRESS);
    expect((await errorOf(await confirm(app, b.headers, code))).code).toBe("email_code_none");
    expect((await confirm(app, a.headers, code)).status).toBe(200);
    expect(await stateOf(app, b.headers)).toMatchObject({ confirmed: false });
  });

  test("an erased account's requests answer as for nobody", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    await ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [a.accountId]);
    // The session guard refuses a tombstone's session before the routes are reached.
    for (const res of [await sendCode(app, a.headers), await confirm(app, a.headers, "123456")]) {
      expect(res.status).toBe(401);
    }
  });

  test("an account erased after the session guard let the request in is answered 404, and nothing is sent", async ({
    ctx,
  }) => {
    // The services themselves, past the guard: erasure tombstoned the account in between.
    const { logger } = await captureLogger();
    const sent: MailMessage[] = [];
    const deps: EmailDeps = {
      db: ctx.client,
      logger,
      now: () => new Date(),
      mailer: {
        send: async (message) => {
          sent.push(message);
        },
      },
    };
    const a = await signedInAccount(ctx.client);
    await setAccountEmail(deps, a.accountId, ADDRESS);
    await ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [a.accountId]);
    for (const attempt of [
      () => sendEmailCode(deps, a.accountId, englishT),
      () => confirmEmailCode(deps, a.accountId, "123456"),
    ]) {
      const refused = await attempt().catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(AppError);
      expect(refused).toMatchObject({ status: 404, code: "not_found" });
    }
    expect(sent).toEqual([]);
    expect(await rowsOf(ctx, "email_send", a.accountId)).toBe(0);
  });

  test("a mailer that fails in a way of its own is rolled back the same and answers 500, not 503", async ({
    ctx,
  }) => {
    // A fault of ours, not SES's refusal: no promise that a later try works,
    // the error goes to the reporter, and the address stays out of the log.
    const broken: Mailer = {
      send: async ({ to }) => {
        throw new TypeError(`no template for ${to}`);
      },
    };
    const { app, logs } = await appWith(ctx, { mailer: broken });
    const a = await signedInAccount(ctx.client);
    await setAddress(app, a.headers, ADDRESS);
    const res = await sendCode(app, a.headers);
    expect(res.status).toBe(500);
    expect((await errorOf(res)).code).toBe("internal_error");
    expect(await rowsOf(ctx, "email_code", a.accountId)).toBe(0);
    expect(await rowsOf(ctx, "email_send", a.accountId)).toBe(0);
    expect(logs().map((l) => l.msg)).toContain("unhandled error");
    expect(logs().map((l) => l.msg)).not.toContain("email code not sent");
    expect(JSON.stringify(logs())).not.toContain("confirm@");
  });
});

/** 12:00 in Finland, one Tuesday: every send of a race counts on the same day. */
const T = new Date("2026-10-20T09:00:00.000Z");

/** The services on `db` at T, the mail kept in `sent`. */
async function depsOn(db: Queryable, sent: MailMessage[]): Promise<EmailDeps> {
  const { logger } = await captureLogger();
  return {
    db,
    logger,
    now: () => T,
    mailer: { send: async (message) => void sent.push(message) },
  };
}

const refusalOf = (work: Promise<unknown>) => work.catch((error: unknown) => error);

// Two phones at once (ADR-021's deterministic interleaving): each piece of
// work runs in a transaction of its own connection; the first's holds the
// account's row until the test commits it, Postgres is asked until the second
// waits for that lock, and only then is the first committed.
describe("two requests at once on one address", () => {
  test("two sends with one left of the day's five: one is sent, the other refused", async () => {
    await withTwoConnections("kuutti-385-send", async (pool, first, second) => {
      const sent: MailMessage[] = [];
      const a = await signedInAccount(pool, "email-race-send");
      const deps = await depsOn(pool, sent);
      await setAccountEmail(deps, a.accountId, ADDRESS);
      for (let i = 0; i < 4; i += 1) await sendEmailCode(deps, a.accountId, englishT);
      const [firstPid, secondPid] = [await pidOf(first), await pidOf(second)];
      await first.query("BEGIN");
      await second.query("BEGIN");
      const answered = await sendEmailCode({ ...deps, db: first }, a.accountId, englishT);
      const racing = watched(sendEmailCode({ ...deps, db: second }, a.accountId, englishT));
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      // Counted after the first's commit: the fifth is spent, so no sixth goes out.
      expect(await racing.outcome).toBe("email_code_budget_exceeded");
      await second.query("COMMIT");
      expect(answered).toEqual({
        email: ADDRESS,
        confirmed: false,
        codeExpiresAt: new Date(T.getTime() + 30 * MINUTE).toISOString(),
      });
      expect(sent).toHaveLength(5);
      expect(await countIn(pool, "email_send", a.accountId)).toBe(5);
      // The code that waits is the fifth, the one that went out.
      const { rows } = await pool.query<{ code_hash: string }>(
        "SELECT code_hash FROM email_code WHERE account_id = $1",
        [a.accountId],
      );
      expect(rows).toEqual([{ code_hash: hashCode(a.accountId, codeIn(sent[4])) }]);
    });
  });

  test("two wrong codes with one try left before the last: one counts, the other spends it", async () => {
    await withTwoConnections("kuutti-385-wrong", async (pool, first, second) => {
      const sent: MailMessage[] = [];
      const a = await signedInAccount(pool, "email-race-wrong");
      const deps = await depsOn(pool, sent);
      await setAccountEmail(deps, a.accountId, ADDRESS);
      await sendEmailCode(deps, a.accountId, englishT);
      const wrong = wrongFor(codeIn(sent[0]));
      // One wrong try already: one of three counted.
      expect(await refusalOf(confirmEmailCode(deps, a.accountId, wrong))).toMatchObject({
        code: "email_code_wrong",
        detail: { attemptsLeft: 2 },
      });
      const [firstPid, secondPid] = [await pidOf(first), await pidOf(second)];
      await first.query("BEGIN");
      await second.query("BEGIN");
      const counted = await refusalOf(confirmEmailCode({ ...deps, db: first }, a.accountId, wrong));
      expect(counted).toMatchObject({
        status: 400,
        code: "email_code_wrong",
        detail: { attemptsLeft: 1 },
      });
      const racing = watched(confirmEmailCode({ ...deps, db: second }, a.accountId, wrong));
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      // It reads the first's count, so the two tries are two, not one counted twice.
      expect(await racing.outcome).toBe("email_code_spent");
      await second.query("COMMIT");
      expect(await countIn(pool, "email_code", a.accountId)).toBe(0);
    });
  });

  test("two right codes: both answer confirmed, with no code waiting", async () => {
    await withTwoConnections("kuutti-385-right", async (pool, first, second) => {
      const sent: MailMessage[] = [];
      const a = await signedInAccount(pool, "email-race-right");
      const deps = await depsOn(pool, sent);
      await setAccountEmail(deps, a.accountId, ADDRESS);
      await sendEmailCode(deps, a.accountId, englishT);
      const code = codeIn(sent[0]);
      const [firstPid, secondPid] = [await pidOf(first), await pidOf(second)];
      await first.query("BEGIN");
      await second.query("BEGIN");
      const answered = await confirmEmailCode({ ...deps, db: first }, a.accountId, code);
      const racing = watched(confirmEmailCode({ ...deps, db: second }, a.accountId, code));
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      // The second's read waited for the account's row and saw it confirmed,
      // but joined the code as it was before the wait: the code it saw is gone.
      const confirmed = { email: ADDRESS, confirmed: true, codeExpiresAt: null };
      expect(await racing.outcome).toEqual(confirmed);
      await second.query("COMMIT");
      expect(answered).toEqual(confirmed);
      expect(await readEmail(deps, a.accountId)).toEqual(confirmed);
      expect(await countIn(pool, "email_code", a.accountId)).toBe(0);
    });
  });

  test("the right code and a different address: the confirmation first, then the change", async () => {
    await withTwoConnections("kuutti-385-confirm-change", async (pool, first, second) => {
      const sent: MailMessage[] = [];
      const a = await signedInAccount(pool, "email-race-confirm-change");
      const deps = await depsOn(pool, sent);
      await setAccountEmail(deps, a.accountId, ADDRESS);
      await sendEmailCode(deps, a.accountId, englishT);
      const [firstPid, secondPid] = [await pidOf(first), await pidOf(second)];
      await first.query("BEGIN");
      await second.query("BEGIN");
      const confirmed = await confirmEmailCode(
        { ...deps, db: first },
        a.accountId,
        codeIn(sent[0]),
      );
      expect(confirmed).toEqual({ email: ADDRESS, confirmed: true, codeExpiresAt: null });
      const racing = watched(setAccountEmail({ ...deps, db: second }, a.accountId, OTHER));
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      // The confirmation was of the old address; the new one starts over.
      const changed = { email: OTHER, confirmed: false, codeExpiresAt: null };
      expect(await racing.outcome).toEqual(changed);
      await second.query("COMMIT");
      expect(await readEmail(deps, a.accountId)).toEqual(changed);
      expect(await countIn(pool, "email_code", a.accountId)).toBe(0);
    });
  });

  test("the right code and a different address: the change first, then the confirmation", async () => {
    await withTwoConnections("kuutti-385-change-confirm", async (pool, first, second) => {
      const sent: MailMessage[] = [];
      const a = await signedInAccount(pool, "email-race-change-confirm");
      const deps = await depsOn(pool, sent);
      await setAccountEmail(deps, a.accountId, ADDRESS);
      await sendEmailCode(deps, a.accountId, englishT);
      const [firstPid, secondPid] = [await pidOf(first), await pidOf(second)];
      await first.query("BEGIN");
      await second.query("BEGIN");
      const changed = { email: OTHER, confirmed: false, codeExpiresAt: null };
      expect(await setAccountEmail({ ...deps, db: first }, a.accountId, OTHER)).toEqual(changed);
      const racing = watched(
        confirmEmailCode({ ...deps, db: second }, a.accountId, codeIn(sent[0])),
      );
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      // The code went with the old address: it confirms nothing of the new one.
      expect(await racing.outcome).toBe("email_code_none");
      await second.query("COMMIT");
      expect(await readEmail(deps, a.accountId)).toEqual(changed);
      expect(await countIn(pool, "email_code", a.accountId)).toBe(0);
    });
  });
});

describe("the code itself", () => {
  test("is six digits, zeros in front, at both ends of the range", () => {
    expect(codeOf(0)).toBe("000000");
    expect(codeOf(42)).toBe("000042");
    expect(codeOf(999_999)).toBe("999999");
  });

  test("is stored as a hash that differs per account and never contains the code", () => {
    const a = hashCode("00000000-0000-4000-8000-00000000000a", "123456");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(hashCode("00000000-0000-4000-8000-00000000000a", "123456"));
    expect(a).not.toBe(hashCode("00000000-0000-4000-8000-00000000000b", "123456"));
    expect(a).not.toBe(hashCode("00000000-0000-4000-8000-00000000000a", "123457"));
    expect(a).not.toContain("123456");
  });

  test("is found in a log line as a value or a word, and not by chance in a time, a pid or a uuid", () => {
    // The search the log assertions above rely on: it would catch a leak.
    const code = "137042";
    for (const leak of [{ code }, { msg: `code ${code} sent` }, { n: 137042 }, { t: `${code}.` }]) {
      expect(logsHoldCode([leak], code)).toBe(true);
    }
    // A pid of six digits, as on Linux; the code inside a time and inside a uuid's hex.
    const chance: LogLine = {
      time: 1_760_137_042_000,
      pid: 137042,
      hostname: code,
      requestId: "6f1c0a2e-9b3d-4e7a-8c21-a137042b9d0e",
      durationMs: 3.1,
      msg: "email code sent",
    };
    expect(logsHoldCode([chance], code)).toBe(false);
  });
});
