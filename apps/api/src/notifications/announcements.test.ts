import {
  AdminAnnouncement,
  AdminAnnouncementList,
  type AnnouncementDraft,
  Notices,
  PushData,
} from "@kuutti/schema";
import { it } from "vitest";
import { type App, createApp } from "../app.ts";
import { MailFailed, type MailMessage } from "../lib/mail.ts";
import { type SignedIn, signedInAccount, staffSession } from "../test/account.ts";
import {
  captureLogger,
  describe,
  expect,
  type TestContext,
  test,
  testConfig,
} from "../test/harness.ts";
import { heldSchedule, memoryPusher } from "../test/push.ts";
import { announcementTextFor } from "./announcements.ts";
import { createPush } from "./push.ts";

// Announcements (#573, ADR-068, features/notifications/announcements.feature):
// an admin writes one, another approves it, and the approval tells everybody:
// a notice in the app, an email to the confirmed addresses, a push in the
// app's own words. The app is the real one, handed a push over a memory
// pusher and a memory mailer, a held schedule for the quiet hours' wait and a
// clock the test moves; a test waits for the sending with `settled`.

/** 12:00 in Helsinki, a Friday in summer time (UTC+3): outside the quiet hours. */
const NOON = new Date("2026-10-16T09:00:00.000Z");
/** 23:00 in Helsinki the same day: inside them, which end at 08:00. */
const LATE = new Date("2026-10-16T20:00:00.000Z");
/** 08:00 in Helsinki the next morning, when they end. */
const MORNING = new Date("2026-10-17T05:00:00.000Z");

const DRAFT = {
  en: { title: "A short break on Sunday", body: "Kuutti is closed from 10 to 12 for maintenance." },
  fi: { title: "Lyhyt tauko sunnuntaina", body: "Kuutti on suljettu kello 10–12 huollon vuoksi." },
} satisfies AnnouncementDraft;
const SWEDISH = {
  title: "Ett kort avbrott på söndag",
  body: "Kuutti är stängd klockan 10–12 för underhåll.",
};

type Headers = Record<string, string>;
const json = (headers: Headers) => ({ ...headers, "content-type": "application/json" });

/** The app with a push of its own over a memory pusher and a memory mailer, a held schedule and a clock. */
async function appWith(ctx: TestContext, at = NOON) {
  const { logger, lines } = await captureLogger();
  const pusher = memoryPusher();
  const sent: MailMessage[] = [];
  const mailer = { send: async (message: MailMessage) => void sent.push(message) };
  const clock = { at };
  const schedule = heldSchedule();
  const push = createPush({
    db: ctx.client,
    logger,
    now: () => clock.at,
    pusher,
    mailer,
    online: () => false,
    schedule: schedule.schedule,
    pause: async () => {},
  });
  const app = createApp({
    config: testConfig(),
    logger,
    db: ctx.client,
    now: () => clock.at,
    pusher,
    mailer,
    push,
  });
  return { app, pusher, sent, clock, schedule, settled: () => push.settled(), logs: lines };
}

const write = (app: App, headers: Headers, draft: unknown) =>
  app.request("/admin/announcements", {
    method: "POST",
    headers: json(headers),
    body: JSON.stringify(draft),
  });

const approve = (app: App, headers: Headers, id: string) =>
  app.request(`/admin/announcements/${id}/approve`, { method: "POST", headers });

const remove = (app: App, headers: Headers, id: string) =>
  app.request(`/admin/announcements/${id}`, { method: "DELETE", headers });

const list = async (app: App, headers: Headers) => {
  const answer = await app.request("/admin/announcements", { headers });
  expect(answer.status).toBe(200);
  return AdminAnnouncementList.parse(await answer.json());
};

/** A draft written by `headers`'s admin, as the panel answered it. */
async function written(app: App, headers: Headers, draft: AnnouncementDraft = DRAFT) {
  const answer = await write(app, headers, draft);
  expect(answer.status).toBe(201);
  return AdminAnnouncement.parse(await answer.json());
}

const errorCode = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

/** The person's notices, in `language`. */
async function noticesOf(app: App, who: SignedIn, language = "en") {
  const answer = await app.request("/notices", {
    headers: { ...who.headers, "accept-language": language },
  });
  expect(answer.status).toBe(200);
  return Notices.parse(await answer.json()).notices;
}

let tokens = 0;
/** The person's phone registers its token, in its language. */
async function phoneOf(app: App, who: SignedIn, language = "en") {
  tokens += 1;
  const token = `ExponentPushToken[announcement-${process.pid}-${tokens}]`;
  const answer = await app.request("/push-token", {
    method: "PUT",
    headers: { ...json(who.headers), "accept-language": language },
    body: JSON.stringify({ token, platform: "android" }),
  });
  expect(answer.status).toBe(204);
  return token;
}

/** The person switches announcements off, through the route. */
async function switchOff(app: App, who: SignedIn) {
  const answer = await app.request("/account/notifications/announcement", {
    method: "PUT",
    headers: json(who.headers),
    body: JSON.stringify({ enabled: false }),
  });
  expect(answer.status).toBe(200);
}

/** A confirmed address, and the terms read in `locale`. */
async function confirmed(ctx: TestContext, who: SignedIn, address: string, locale: string) {
  await ctx.client.query(
    "UPDATE account SET email = $2, email_confirmed_at = now() WHERE id = $1",
    [who.accountId, address],
  );
  await ctx.client.query(
    `INSERT INTO consent (account_id, kind, version, locale_shown)
     VALUES ($1, 'terms', 'test', $2)`,
    [who.accountId, locale],
  );
}

const auditOf = async (ctx: TestContext, id: string) =>
  (
    await ctx.client.query<{ actor_identity_id: string; action: string; detail: unknown }>(
      // One test is one transaction, whose now() every row shares: by action.
      `SELECT actor_identity_id, action, detail FROM audit_log
        WHERE subject_type = 'announcement' AND subject_id = $1 ORDER BY action`,
      [id],
    )
  ).rows;

const noticeCount = async (ctx: TestContext, id: string) =>
  (
    await ctx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM notice WHERE announcement_id = $1",
      [id],
    )
  ).rows[0]?.n;

describe("announcements", () => {
  test("An announcement goes only once another admin approves it", async ({ ctx }) => {
    const { app, pusher, sent, settled } = await appWith(ctx);
    const writer = await staffSession(ctx.client, "admin");
    const other = await staffSession(ctx.client, "admin");
    const person = await signedInAccount(ctx.client);
    await phoneOf(app, person);
    await confirmed(ctx, person, "person@example.test", "en");
    const draft = await written(app, writer.headers);
    expect(draft).toMatchObject({ approvedAt: null, yours: true, sv: null });

    const own = await approve(app, writer.headers, draft.id);
    expect(own.status).toBe(409);
    expect(await errorCode(own)).toBe("own_announcement");
    await settled();
    expect(await noticeCount(ctx, draft.id)).toBe(0);
    expect(pusher.sent()).toEqual([]);
    expect(sent).toEqual([]);

    const approved = await approve(app, other.headers, draft.id);
    expect(approved.status).toBe(200);
    expect(AdminAnnouncement.parse(await approved.json())).toMatchObject({
      id: draft.id,
      approvedAt: NOON.toISOString(),
      yours: false,
    });
    await settled();
    expect(await noticesOf(app, person)).toEqual([
      expect.objectContaining({ kind: "announcement", title: DRAFT.en.title }),
    ]);
    const mailedHere = () => sent.filter((message) => message.to === "person@example.test");
    expect(pusher.sent()).toHaveLength(1);
    expect(mailedHere()).toHaveLength(1);
    // Once is all: a second approval, by anybody, sends nothing more.
    const again = await approve(app, other.headers, draft.id);
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("announcement_sent");
    await settled();
    expect(pusher.sent()).toHaveLength(1);
    expect(mailedHere()).toHaveLength(1);
    // Who did what is the audit log's, with no words of the announcement.
    const notices = await noticeCount(ctx, draft.id);
    expect(await auditOf(ctx, draft.id)).toEqual([
      {
        actor_identity_id: other.identityId,
        action: "announcement.approve",
        detail: { notices },
      },
      {
        actor_identity_id: writer.identityId,
        action: "announcement.write",
        detail: { swedish: false },
      },
    ]);
  });

  test("An approved announcement reaches everybody as a notice in their language", async ({
    ctx,
  }) => {
    const { app, settled } = await appWith(ctx);
    const [writer, other] = [
      await staffSession(ctx.client, "admin"),
      await staffSession(ctx.client, "admin"),
    ];
    const people = [
      await signedInAccount(ctx.client),
      await signedInAccount(ctx.client),
      await signedInAccount(ctx.client),
    ];
    // Somebody erased is told nothing; a newcomer still onboarding and somebody
    // on a break are told as anybody is, and read it when they come.
    const gone = await signedInAccount(ctx.client);
    await ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [gone.accountId]);
    const newcomer = await signedInAccount(ctx.client, undefined, { state: "registered" });
    const resting = await signedInAccount(ctx.client);
    await ctx.client.query("UPDATE account SET state = 'paused' WHERE id = $1", [
      resting.accountId,
    ]);
    const { id } = await written(app, writer.headers);
    expect((await approve(app, other.headers, id)).status).toBe(200);
    await settled();
    const [finn, swede, englishman] = people as [SignedIn, SignedIn, SignedIn];
    const words = async (who: SignedIn, language: string) =>
      (await noticesOf(app, who, language)).map((notice) =>
        notice.kind === "announcement" ? [notice.title, notice.body] : notice.kind,
      );
    expect(await words(finn, "fi")).toEqual([[DRAFT.fi.title, DRAFT.fi.body]]);
    expect(await words(swede, "sv")).toEqual([[DRAFT.en.title, DRAFT.en.body]]);
    expect(await words(englishman, "en")).toEqual([[DRAFT.en.title, DRAFT.en.body]]);
    // Stadi reads the Finnish.
    expect(await words(finn, "fi-x-stadi")).toEqual([[DRAFT.fi.title, DRAFT.fi.body]]);
    const told = async (who: SignedIn) =>
      (
        await ctx.client.query(
          "SELECT 1 FROM notice WHERE account_id = $1 AND announcement_id = $2",
          [who.accountId, id],
        )
      ).rows.length;
    expect(await told(gone)).toBe(0);
    expect(await told(newcomer)).toBe(1);
    expect(await told(resting)).toBe(1);
    // Every account that is not erased, and no more.
    const { rows: live } = await ctx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM account WHERE state <> 'deleted'",
    );
    expect(await noticeCount(ctx, id)).toBe(live[0]?.n);
  });

  test("The push says only that there is an announcement, to those whose switch is on", async ({
    ctx,
  }) => {
    const { app, pusher, settled } = await appWith(ctx);
    const [writer, other] = [
      await staffSession(ctx.client, "admin"),
      await staffSession(ctx.client, "admin"),
    ];
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const aPhone = await phoneOf(app, a, "fi");
    await phoneOf(app, b);
    await switchOff(app, b);
    const { id } = await written(app, writer.headers);
    expect((await approve(app, other.headers, id)).status).toBe(200);
    await settled();
    expect(pusher.sent()).toEqual([
      expect.objectContaining({
        to: aPhone,
        body: "Tiedote Kuutilta",
        data: { kind: "announcement" },
      }),
    ]);
    const [push] = pusher.sent();
    expect(PushData.parse(push?.data)).toEqual({ kind: "announcement" });
    // Not a word of the announcement passes through Expo.
    const shown = JSON.stringify(pusher.sent());
    for (const words of [DRAFT.en.title, DRAFT.en.body, DRAFT.fi.title, DRAFT.fi.body]) {
      expect(shown).not.toContain(words);
    }
    // B switched it off, and still has the notice.
    expect(await noticesOf(app, b)).toHaveLength(1);
  });

  test("An announcement approved in the quiet hours is pushed once they end", async ({ ctx }) => {
    const { app, pusher, clock, schedule, settled } = await appWith(ctx, LATE);
    const [writer, other] = [
      await staffSession(ctx.client, "admin"),
      await staffSession(ctx.client, "admin"),
    ];
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const aPhone = await phoneOf(app, a);
    await phoneOf(app, b);
    const { id } = await written(app, writer.headers);
    expect((await approve(app, other.headers, id)).status).toBe(200);
    await settled();
    expect(pusher.sent()).toEqual([]);
    // It waits until 08:00 in Helsinki: nine hours.
    expect(schedule.tasks.map((task) => task.ms)).toEqual([9 * 60 * 60 * 1000]);
    const [notice] = await noticesOf(app, b);
    const read = await app.request(`/notices/${notice?.id}/read`, {
      method: "POST",
      headers: b.headers,
    });
    expect(read.status).toBe(204);
    clock.at = MORNING;
    expect(await schedule.runAll()).toBe(1);
    await settled();
    expect(pusher.sent().map((push) => push.to)).toEqual([aPhone]);
  });

  test("The email goes to confirmed addresses whose switch is on, in the language of their terms", async ({
    ctx,
  }) => {
    const { app, sent, settled, logs } = await appWith(ctx);
    const [writer, other] = [
      await staffSession(ctx.client, "admin"),
      await staffSession(ctx.client, "admin"),
    ];
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const c = await signedInAccount(ctx.client);
    const d = await signedInAccount(ctx.client);
    await confirmed(ctx, a, "a@example.test", "sv");
    await confirmed(ctx, b, "b@example.test", "fi");
    await switchOff(app, b);
    await ctx.client.query("UPDATE account SET email = 'c@example.test' WHERE id = $1", [
      c.accountId,
    ]);
    await confirmed(ctx, d, "d@example.test", "fi");
    const { id } = await written(app, writer.headers);
    expect((await approve(app, other.headers, id)).status).toBe(200);
    await settled();
    const mine = sent.filter((message) => message.to.endsWith("@example.test"));
    expect(mine.map((message) => message.to).sort()).toEqual(["a@example.test", "d@example.test"]);
    const toA = mine.find((message) => message.to === "a@example.test");
    expect(toA).toEqual({
      to: "a@example.test",
      subject: `Kuutti: ${DRAFT.en.title}`,
      text: [
        DRAFT.en.title,
        DRAFT.en.body,
        "You get this because you confirmed this address in the Kuutti app. Announcements can be turned off in Settings, under Notifications.",
        "Kuutti ry",
      ].join("\n\n"),
    });
    const toD = mine.find((message) => message.to === "d@example.test");
    expect(toD?.subject).toBe(`Kuutti: ${DRAFT.fi.title}`);
    expect(toD?.text.startsWith(`${DRAFT.fi.title}\n\n${DRAFT.fi.body}\n\nSaat tämän`)).toBe(true);
    for (const message of mine) expect(message.text).not.toMatch(/https?:|www\./);
    // No address and no words of it in a log line.
    const logged = JSON.stringify(logs());
    for (const words of ["@example.test", DRAFT.en.body, DRAFT.fi.body]) {
      expect(logged).not.toContain(words);
    }
  });

  test("A draft can be deleted, a sent announcement cannot", async ({ ctx }) => {
    const { app, settled } = await appWith(ctx);
    const [writer, other] = [
      await staffSession(ctx.client, "admin"),
      await staffSession(ctx.client, "admin"),
    ];
    await signedInAccount(ctx.client);
    const draft = await written(app, writer.headers);
    const sentOne = await written(app, writer.headers, { ...DRAFT, sv: SWEDISH });
    expect((await approve(app, other.headers, sentOne.id)).status).toBe(200);
    await settled();
    const notices = await noticeCount(ctx, sentOne.id);
    // Any admin may delete a draft, the one who wrote it or another.
    expect((await remove(app, other.headers, draft.id)).status).toBe(204);
    const refused = await remove(app, writer.headers, sentOne.id);
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("announcement_sent");
    const items = (await list(app, writer.headers)).items.map((item) => item.id);
    expect(items).toContain(sentOne.id);
    expect(items).not.toContain(draft.id);
    expect(await noticeCount(ctx, sentOne.id)).toBe(notices);
    expect((await auditOf(ctx, draft.id)).map((row) => row.action)).toEqual([
      "announcement.delete",
      "announcement.write",
    ]);
    // Gone is gone: a second delete finds nothing.
    expect((await remove(app, other.headers, draft.id)).status).toBe(404);
  });
});

describe("the panel's announcements", () => {
  test("lists the newest with their words, whether the caller wrote each, and how many one would reach", async ({
    ctx,
  }) => {
    const writer = await staffSession(ctx.client, "admin");
    const other = await staffSession(ctx.client, "admin");
    const person = await signedInAccount(ctx.client);
    await confirmed(ctx, person, "list@example.test", "fi");
    const first = await written(ctx.app, writer.headers);
    const second = await written(ctx.app, other.headers, { ...DRAFT, sv: SWEDISH });
    const answer = await list(ctx.app, writer.headers);
    expect(answer.items.slice(0, 2)).toEqual([
      expect.objectContaining({ id: second.id, sv: SWEDISH, yours: false }),
      expect.objectContaining({ id: first.id, en: DRAFT.en, fi: DRAFT.fi, sv: null, yours: true }),
    ]);
    const { rows } = await ctx.client.query<{ accounts: number; addresses: number }>(
      `SELECT count(*)::int AS accounts,
              count(*) FILTER (WHERE email IS NOT NULL AND email_confirmed_at IS NOT NULL)::int AS addresses
         FROM account WHERE state <> 'deleted'`,
    );
    expect(answer.reach).toMatchObject(rows[0] ?? {});
    // Never who wrote one: only whether the caller did.
    expect(JSON.stringify(answer)).not.toContain(writer.identityId);
  });

  test("trims the words and keeps Swedish whole or not at all", async ({ ctx }) => {
    const admin = await staffSession(ctx.client, "admin");
    const padded = await written(ctx.app, admin.headers, {
      en: { title: `  ${DRAFT.en.title}  `, body: `\n${DRAFT.en.body}\n` },
      fi: DRAFT.fi,
    });
    expect(padded.en).toEqual(DRAFT.en);
    const { rows } = await ctx.client.query(
      "SELECT title_sv, body_sv FROM announcement WHERE id = $1",
      [padded.id],
    );
    expect(rows).toEqual([{ title_sv: null, body_sv: null }]);
  });

  test.for([
    ["no Finnish", { en: DRAFT.en }],
    ["no English", { fi: DRAFT.fi }],
    ["an empty title", { ...DRAFT, en: { ...DRAFT.en, title: "   " } }],
    ["a title of 81 characters", { ...DRAFT, fi: { ...DRAFT.fi, title: "a".repeat(81) } }],
    ["a body of 1,001 characters", { ...DRAFT, en: { ...DRAFT.en, body: "b".repeat(1001) } }],
    ["Swedish with a title alone", { ...DRAFT, sv: { title: SWEDISH.title } }],
    ["a language not offered", { ...DRAFT, de: DRAFT.en }],
    ["a key it does not know", { ...DRAFT, en: { ...DRAFT.en, link: "x" } }],
    ["no object", "just words"],
  ] as const)("refuses %s and writes nothing", async ([, draft], { ctx }) => {
    const admin = await staffSession(ctx.client, "admin");
    const answer = await write(ctx.app, admin.headers, draft);
    expect(answer.status).toBe(400);
    const { rows } = await ctx.client.query("SELECT 1 FROM announcement WHERE written_by = $1", [
      admin.identityId,
    ]);
    expect(rows).toEqual([]);
  });

  test("accepts a title of 80 characters and a body of 1,000", async ({ ctx }) => {
    const admin = await staffSession(ctx.client, "admin");
    const longest = {
      ...DRAFT,
      sv: { title: "t".repeat(80), body: "b".repeat(1000) },
    };
    expect((await write(ctx.app, admin.headers, longest)).status).toBe(201);
  });

  test.for([
    ["an address", "Write to help@kuutti.app", "fi"],
    ["a link", "See https://kuutti.app/status", "en"],
    ["a phone number", "Call 040 123 4567", "sv"],
  ] as const)(
    "refuses %s in its words, naming the language and never the text",
    async ([, words, language], { ctx }) => {
      const admin = await staffSession(ctx.client, "admin");
      const draft = { ...DRAFT, sv: SWEDISH, [language]: { title: "Hello", body: words } };
      const answer = await write(ctx.app, admin.headers, draft);
      expect(answer.status).toBe(400);
      const body = (await answer.json()) as { error: { code: string } };
      expect(body.error.code).toBe("text_contact_details");
      expect(JSON.stringify(body)).not.toContain(words);
      expect(JSON.stringify(ctx.logs())).not.toContain(words);
    },
  );

  test.for([["moderator"], ["researcher"]] as const)(
    "refuses a %s every route",
    async ([role], { ctx }) => {
      const staff = await staffSession(ctx.client, role);
      const admin = await staffSession(ctx.client, "admin");
      const { id } = await written(ctx.app, admin.headers);
      const answers = [
        await ctx.app.request("/admin/announcements", { headers: staff.headers }),
        await write(ctx.app, staff.headers, DRAFT),
        await approve(ctx.app, staff.headers, id),
        await remove(ctx.app, staff.headers, id),
      ];
      expect(answers.map((answer) => answer.status)).toEqual([403, 403, 403, 403]);
      expect(await noticeCount(ctx, id)).toBe(0);
    },
  );

  test("refuses every route without a staff session, a person's session among them", async ({
    ctx,
  }) => {
    const admin = await staffSession(ctx.client, "admin");
    const person = await signedInAccount(ctx.client);
    const { id } = await written(ctx.app, admin.headers);
    for (const headers of [{}, person.headers]) {
      const answers = [
        await ctx.app.request("/admin/announcements", { headers }),
        await write(ctx.app, headers, DRAFT),
        await approve(ctx.app, headers, id),
        await remove(ctx.app, headers, id),
      ];
      expect(answers.map((answer) => answer.status)).toEqual([401, 401, 401, 401]);
    }
  });

  test("answers 404 for an announcement there is not, and 400 for an id that is none", async ({
    ctx,
  }) => {
    const admin = await staffSession(ctx.client, "admin");
    const nobody = "00000000-0000-4000-8000-000000000000";
    expect((await approve(ctx.app, admin.headers, nobody)).status).toBe(404);
    expect((await remove(ctx.app, admin.headers, nobody)).status).toBe(404);
    expect((await approve(ctx.app, admin.headers, "not-an-id")).status).toBe(400);
    expect((await remove(ctx.app, admin.headers, "not-an-id")).status).toBe(400);
  });
});

describe("the email of an announcement", () => {
  test("a send that fails is logged by its reason alone, and the rest go on", async ({ ctx }) => {
    const { logger, lines } = await captureLogger();
    const sent: string[] = [];
    const mailer = {
      send: async (message: MailMessage) => {
        if (message.to === "first@example.test") throw new MailFailed("MessageRejected", 400);
        sent.push(message.to);
      },
    };
    const push = createPush({
      db: ctx.client,
      logger,
      now: () => NOON,
      mailer,
      online: () => false,
      pause: async () => {},
    });
    const app = createApp({ config: testConfig(), logger, db: ctx.client, now: () => NOON, push });
    const [writer, other] = [
      await staffSession(ctx.client, "admin"),
      await staffSession(ctx.client, "admin"),
    ];
    const first = await signedInAccount(ctx.client);
    const second = await signedInAccount(ctx.client);
    await confirmed(ctx, first, "first@example.test", "en");
    await confirmed(ctx, second, "second@example.test", "en");
    const { id } = await written(app, writer.headers);
    expect((await approve(app, other.headers, id)).status).toBe(200);
    await push.settled();
    expect(sent.filter((to) => to.endsWith("@example.test"))).toEqual(["second@example.test"]);
    const failed = lines().filter((line) => line.msg === "announcement mail not sent");
    expect(failed).toEqual([
      expect.objectContaining({
        accountId: first.accountId,
        reason: "MessageRejected",
        status: 400,
      }),
    ]);
    expect(JSON.stringify(lines())).not.toContain("@example.test");
  });
});

describe("announcementTextFor", () => {
  const texts = { en: DRAFT.en, fi: DRAFT.fi, sv: null };

  it.each([
    ["fi", "fi", DRAFT.fi],
    ["fi-x-stadi", "fi", DRAFT.fi],
    ["sv", "en", DRAFT.en],
    ["en", "en", DRAFT.en],
    ["de", "en", DRAFT.en],
    [null, "en", DRAFT.en],
  ] as const)(
    "gives a reader of %s the %s words when there is no Swedish",
    (locale, chosen, text) => {
      expect(announcementTextFor(texts, locale)).toEqual({ locale: chosen, text });
    },
  );

  it("gives a Swedish reader the Swedish where it was written", () => {
    expect(announcementTextFor({ ...texts, sv: SWEDISH }, "sv")).toEqual({
      locale: "sv",
      text: SWEDISH,
    });
  });
});
