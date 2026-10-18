import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import {
  CardPreviewResponse,
  ChatMessage,
  ConversationList,
  ErrorResponse,
  MessagePage,
  PHOTO_MAX_BYTES,
  Photo,
  PhotoList,
  PhotoReviewQueue,
} from "@kuutti/schema";
import sharp from "sharp";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { CURRENT_CONSENT_VERSIONS, eraseAccount } from "../identity/index.ts";
import type { Moderator } from "../media/index.ts";
import {
  deleteOrphanedObjects,
  EXPORT_MESSAGE_PHOTOS_MAX,
  erasePhotosOfAccount,
  exportPhotos,
  objectKey,
  queueSummary,
} from "../media/index.ts";
import { signInAs, staffSession, withMatchingConfig } from "../test/account.ts";
import { cardShown } from "../test/cards.ts";
import { conversationBetween } from "../test/chat.ts";
import { openExport } from "../test/export.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import {
  checked,
  fixtureGif,
  fixtureHugeJpegHeader,
  fixtureJpeg,
  fixturePng,
  scriptedModerator,
  TEST_MEDIA_BASE,
  testMediaDeps,
} from "../test/media.ts";
import { people } from "../test/people.ts";

// features/chat/photos.feature (#350, ADR-031 §3): a photo sent in a
// conversation, end to end on real Postgres in a rolled-back transaction, a
// memory store for the bucket, a CloudFront signer over a test key, and a
// scripted check. With the route's checklist (CLAUDE.md Testing): each
// validation rule, unauthenticated, the wrong user, every error branch, and
// the races by a statement that lands between the early refusals and the
// transaction.

// A marker of letters: a number can turn up in a timestamp by chance.
const MARK = "qzxvkw";
const PER_DAY = 3;
/** Noon in Helsinki on a summer-time day (UTC+3): midnight is twelve hours away. */
const NOON = new Date("2026-10-18T09:00:00.000Z");

type Person = { accountId: string; headers: Record<string, string> };

async function person(ctx: TestContext, name: string): Promise<Person> {
  const [accountId] = await people(ctx.client, null, 1, { complete: true });
  if (!accountId) throw new Error("no person");
  await ctx.client.query("UPDATE profile SET display_name = $2 WHERE account_id = $1", [
    accountId,
    name,
  ]);
  return { accountId, headers: (await signInAs(ctx.client, accountId)).headers };
}

async function appWith(
  ctx: TestContext,
  options: {
    moderator?: Moderator;
    concurrency?: number;
    media?: false;
    now?: () => Date;
    db?: Queryable;
    deliverUnchecked?: boolean;
  } = {},
) {
  await withMatchingConfig(ctx.client, { message_photos_per_day: PER_DAY });
  const { logger, lines } = await captureLogger();
  const media = testMediaDeps({
    concurrency: options.concurrency ?? 2,
    ...(options.deliverUnchecked === undefined
      ? {}
      : { deliverUnchecked: options.deliverUnchecked }),
  });
  const deps = {
    ...media.deps,
    ...(options.moderator ? { moderator: options.moderator } : {}),
  };
  const app = createApp({
    config: testConfig(),
    logger,
    db: options.db ?? ctx.client,
    ...(options.media === false ? {} : { media: deps }),
    ...(options.now ? { now: options.now } : {}),
  });
  return { app, store: media.store, logs: lines, logger, media: deps };
}

function form(
  bytes: Uint8Array,
  options: { clientId?: string; caption?: string; type?: string; extra?: [string, string] } = {},
): FormData {
  const body = new FormData();
  // A copy into a plain ArrayBuffer: Blob refuses a view over a SharedArrayBuffer by type.
  body.append(
    "photo",
    new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], {
      type: options.type ?? "image/jpeg",
    }),
    "photo.jpg",
  );
  body.append("clientId", options.clientId ?? randomUUID());
  if (options.caption !== undefined) body.append("caption", options.caption);
  if (options.extra) body.append(...options.extra);
  return body;
}

const sendPhoto = (
  app: ReturnType<typeof createApp>,
  who: Person,
  id: string,
  body: FormData,
): Promise<Response> =>
  Promise.resolve(
    app.request(`/conversations/${id}/photos`, { method: "POST", headers: who.headers, body }),
  );

const codeOf = async (res: Response) => ErrorResponse.parse(await res.json()).error.code;

const pageOf = async (app: ReturnType<typeof createApp>, who: Person, id: string) =>
  MessagePage.parse(
    await (await app.request(`/conversations/${id}/messages`, { headers: who.headers })).json(),
  );

/** What a refused send left behind: nothing, by every count. */
async function nothingStored(ctx: TestContext, store: { objects: Map<string, unknown> }) {
  const counts = await ctx.client.query<{ photos: number; messages: number }>(
    `SELECT (SELECT count(*)::int FROM photo WHERE purpose = 'message') AS photos,
            (SELECT count(*)::int FROM message WHERE kind = 'photo') AS messages`,
  );
  expect(counts.rows[0]).toEqual({ photos: 0, messages: 0 });
  expect(store.objects.size).toBe(0);
}

/** A database that runs `land` once, right after the first statement `after` matches. */
function landingAfter(ctx: TestContext, after: string, land: () => Promise<void>): Queryable {
  let landed = false;
  return {
    async query(text: string, values?: unknown[]) {
      const result = await ctx.client.query(text, values);
      if (!landed && text.includes(after)) {
        landed = true;
        await land();
      }
      return result;
    },
  } as unknown as Queryable;
}

const EARLY_COUNT = "purpose = 'message' AND created_at >= $2";

describe("a photo in a message", () => {
  test("A photo goes through the pipeline and reaches the conversation, small and full, for its two people only", async ({
    ctx,
  }) => {
    const moderator = scriptedModerator(checked([]));
    const { app, store } = await appWith(ctx, { moderator });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const c = await person(ctx, "Cia");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);

    const res = await sendPhoto(app, a, id, form(await fixtureJpeg(), { caption: "  Järvellä  " }));
    expect(res.status).toBe(201);
    const message = ChatMessage.parse(await res.json());
    expect(message).toMatchObject({ seq: 1, side: "mine", kind: "photo", body: "Järvellä" });
    const photo = message.photo;
    if (!photo?.urls) throw new Error("no signed photo");
    expect(photo.urls.thumb.startsWith(`${TEST_MEDIA_BASE}/media/`)).toBe(true);
    expect(photo.urls.thumb).toContain("/thumb.webp");
    expect(photo.urls.full).toContain("/full.webp");
    expect(new Date(photo.urls.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // The three variants, WebP, without the camera's EXIF and GPS; no original.
    const keys = [...store.objects.keys()].sort();
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      expect(key).toMatch(/^media\/[0-9a-f]{64}\/(card|full|thumb)\.webp$/);
      const meta = await sharp(store.objects.get(key)).metadata();
      expect([key, meta.format, meta.exif, meta.xmp]).toEqual([key, "webp", undefined, undefined]);
    }
    const full = store.objects.get(keys.find((key) => key.endsWith("full.webp")) ?? "");
    // The check read the full size, what the recipient sees.
    expect(moderator.seen).toEqual([full?.length]);

    const row = await ctx.client.query("SELECT purpose, position, state FROM photo WHERE id = $1", [
      photo.photoId,
    ]);
    expect(row.rows).toEqual([{ purpose: "message", position: null, state: "approved" }]);

    // B's page signs the photo for B; each issuance is a fetch logged as a message photo's.
    const theirs = (await pageOf(app, b, id)).messages[0];
    expect(theirs).toMatchObject({
      side: "theirs",
      kind: "photo",
      body: "Järvellä",
      clientId: null,
      photo: { photoId: photo.photoId, urls: { thumb: expect.stringContaining("/thumb.webp") } },
    });
    const access = await ctx.client.query<{ account_id: string; variant: string; purpose: string }>(
      "SELECT account_id, variant::text AS variant, purpose FROM photo_access WHERE photo_id = $1 ORDER BY account_id, variant::text",
      [photo.photoId],
    );
    expect(access.rows).toHaveLength(4);
    expect(new Set(access.rows.map((r) => r.purpose))).toEqual(new Set(["message"]));
    expect(access.rows.filter((r) => r.account_id === b.accountId).map((r) => r.variant)).toEqual([
      "full",
      "thumb",
    ]);

    // Nobody else's conversation: a 404 for the third account, as for a missing one.
    const stranger = await app.request(`/conversations/${id}/messages`, { headers: c.headers });
    expect(stranger.status).toBe(404);
    const strangerSend = await sendPhoto(app, c, id, form(await fixturePng()));
    expect(strangerSend.status).toBe(404);
  });

  test("A photo the check is sure of is refused in words, and nothing is stored", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    for (const [label, code] of [
      ["Explicit Nudity", "photo_rejected_nudity"],
      ["Weapons", "photo_rejected_violence"],
      ["Corpses", "photo_rejected_other"],
    ] as const) {
      const { app, store } = await appWith(ctx, {
        moderator: scriptedModerator(checked([[label, 97]])),
      });
      const res = await sendPhoto(app, a, id, form(await fixtureJpeg({ exif: false })));
      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe(code);
      await nothingStored(ctx, store);
    }
    // The check's note, as for a profile photo (#253), names no photo: none was stored.
    const notes = await ctx.client.query<{ kind: string; photo_id: string | null }>(
      "SELECT kind::text AS kind, photo_id FROM photo_check_note WHERE account_id = $1 ORDER BY kind::text",
      [a.accountId],
    );
    expect(notes.rows).toEqual([
      { kind: "disturbing", photo_id: null },
      { kind: "nudity", photo_id: null },
      { kind: "violence", photo_id: null },
    ]);
  });

  test("A photo the check is unsure of is delivered and asks nobody, and one no check saw only on a developer's machine", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const unsure = await appWith(ctx, {
      moderator: scriptedModerator(checked([["Explicit Nudity", 75]])),
    });
    const unchecked = await appWith(ctx);
    const sent: string[] = [];
    for (const { app } of [unsure, unchecked]) {
      const res = await sendPhoto(app, a, id, form(await fixtureJpeg({ exif: false })));
      expect(res.status).toBe(201);
      sent.push(ChatMessage.parse(await res.json()).photo?.photoId ?? "");
    }
    const states = async () =>
      (
        await ctx.client.query<{ state: string; decision: string }>(
          `SELECT p.state, r.decision FROM photo p JOIN photo_review r ON r.photo_id = p.id
           WHERE p.account_id = $1 ORDER BY p.created_at`,
          [a.accountId],
        )
      ).rows;
    const queued = [
      { state: "queued", decision: "queued" },
      { state: "queued", decision: "queued" },
    ];
    expect(await states()).toEqual(queued);
    // Nobody's queue: neither the list nor its count holds them.
    expect((await queueSummary(ctx.client)).waiting).toBe(0);
    // Nor the panel's: its queue lists neither and counts neither, and its
    // photo routes know no message photo, so no member of staff sees one or
    // decides on it.
    const staff = await staffSession(ctx.client);
    const panel = await unsure.app.request("/admin/photos/queue", { headers: staff.headers });
    expect(panel.status).toBe(200);
    const queue = PhotoReviewQueue.parse(await panel.json());
    expect(queue.total).toBe(0);
    for (const photoId of sent) {
      expect(queue.items.map((item) => item.photoId)).not.toContain(photoId);
      const card = await unsure.app.request(`/admin/photos/${photoId}/card`, {
        headers: staff.headers,
      });
      expect([card.status, await codeOf(card)]).toEqual([404, "not_found"]);
      for (const decision of [{ decision: "approve" }, { decision: "reject", reason: "other" }]) {
        const decided = await unsure.app.request(`/admin/photos/${photoId}/decision`, {
          method: "POST",
          headers: { ...staff.headers, "content-type": "application/json" },
          body: JSON.stringify(decision),
        });
        expect([decided.status, await codeOf(decided)]).toEqual([404, "not_found"]);
      }
    }
    expect(await states()).toEqual(queued);
    expect((await pageOf(ctx.app, b, id)).messages.map((m) => m.kind)).toEqual(["photo", "photo"]);
    // Anywhere but a developer's machine, a photo no check saw is refused:
    // no moderator at all, or one that queues everything.
    for (const moderator of [undefined, scriptedModerator(checked(null))]) {
      const deployed = await appWith(ctx, {
        deliverUnchecked: false,
        ...(moderator ? { moderator } : {}),
      });
      const res = await sendPhoto(deployed.app, a, id, form(await fixturePng(320, 240)));
      expect([res.status, await codeOf(res)]).toEqual([503, "media_busy"]);
      expect(deployed.store.objects.size).toBe(0);
    }
  });

  test("under a closer look (#253) a photo is refused from the closer look's line, and leaves no note of its own", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, {
      photo_moderation_nudity_review: 60,
      photo_moderation_nudity_reject: 90,
      photo_closer_look_attempts: 2,
      photo_closer_look_window_days: 30,
      photo_closer_look_days: 30,
      photo_closer_look_reject: 75,
    });
    // Between the closer look's line and the usual one: sure only under the closer look.
    const { app, store } = await appWith(ctx, {
      moderator: scriptedModerator(checked([["Explicit Nudity", 80]])),
      now: () => NOON,
    });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    // Two notes within the window start A's closer look; B has none.
    for (const daysAgo of [20, 9]) {
      await ctx.client.query(
        "INSERT INTO photo_check_note (account_id, kind, at) VALUES ($1, 'nudity', $2)",
        [a.accountId, new Date(NOON.getTime() - daysAgo * 86_400_000)],
      );
    }
    const notesOf = async (accountId: string) =>
      (
        await ctx.client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM photo_check_note WHERE account_id = $1",
          [accountId],
        )
      ).rows[0]?.n;

    const refused = await sendPhoto(app, a, id, form(await fixtureJpeg({ exif: false })));
    expect([refused.status, await codeOf(refused)]).toEqual([400, "photo_rejected_nudity"]);
    await nothingStored(ctx, store);
    // Only what the usual lines are sure of is noted: the closer look never prolongs itself.
    expect(await notesOf(a.accountId)).toBe(2);

    // Without a closer look the same label is one the check is unsure of: delivered, unnoted.
    const delivered = await sendPhoto(app, b, id, form(await fixtureJpeg({ exif: false })));
    expect(delivered.status).toBe(201);
    const photoId = ChatMessage.parse(await delivered.json()).photo?.photoId;
    const row = await ctx.client.query<{ state: string; decision: string }>(
      "SELECT p.state, r.decision FROM photo p JOIN photo_review r ON r.photo_id = p.id WHERE p.id = $1",
      [photoId],
    );
    expect(row.rows).toEqual([{ state: "queued", decision: "queued" }]);
    expect(await notesOf(b.accountId)).toBe(0);
  });

  test("The day's tries are counted, refused ones included", async ({ ctx }) => {
    const moderator = scriptedModerator(checked([]));
    const { app } = await appWith(ctx, { moderator });
    await withMatchingConfig(ctx.client, { message_photo_attempts_per_day: 2 });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const bytes = await fixturePng();
    for (let i = 0; i < 2; i += 1) {
      const refused = await sendPhoto(app, a, id, form(bytes, { caption: "0401234567" }));
      expect(refused.status).toBe(400);
    }
    const over = await sendPhoto(app, a, id, form(bytes));
    expect([over.status, await codeOf(over)]).toEqual([429, "message_photo_budget_exceeded"]);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(moderator.seen).toEqual([]);
  });

  test("the day's tries end at midnight in Finland, as the day's photos do, so the refusal's words hold", async ({
    ctx,
  }) => {
    // 23.50 in Helsinki (summer time).
    let clock = new Date("2026-10-18T20:50:00.000Z");
    const { app } = await appWith(ctx, {
      moderator: scriptedModerator(checked([])),
      now: () => clock,
    });
    await withMatchingConfig(ctx.client, { message_photo_attempts_per_day: 1 });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const bytes = await fixturePng();
    expect((await sendPhoto(app, a, id, form(bytes, { caption: "0401234567" }))).status).toBe(400);
    const over = await sendPhoto(app, a, id, form(bytes));
    expect([over.status, await codeOf(over)]).toEqual([429, "message_photo_budget_exceeded"]);
    expect(over.headers.get("retry-after")).toBe("600");
    clock = new Date("2026-10-18T21:00:00.000Z");
    expect((await sendPhoto(app, a, id, form(bytes))).status).toBe(201);
  });

  test("A check that cannot run refuses the photo for now", async ({ ctx }) => {
    const { app, store } = await appWith(ctx, {
      moderator: scriptedModerator(new Error("Rekognition is down")),
    });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const res = await sendPhoto(app, a, id, form(await fixtureJpeg({ exif: false })));
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe("media_busy");
    expect(res.headers.get("retry-after")).toBe("30");
    await nothingStored(ctx, store);
  });

  test("The day's photos are counted, and the next one is refused until midnight", async ({
    ctx,
  }) => {
    const moderator = scriptedModerator(checked([]));
    const { app, store } = await appWith(ctx, { moderator, now: () => NOON });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    for (let i = 0; i < PER_DAY; i += 1) {
      const res = await sendPhoto(app, a, id, form(await fixturePng(300 + i, 300)));
      expect(res.status).toBe(201);
    }
    const objects = store.objects.size;
    const over = await sendPhoto(app, a, id, form(await fixturePng(999, 300)));
    expect(over.status).toBe(429);
    expect(await codeOf(over)).toBe("message_photo_budget_exceeded");
    expect(over.headers.get("retry-after")).toBe(String(12 * 3600));
    // Refused before any picture was read.
    expect(moderator.seen).toHaveLength(PER_DAY);
    expect(store.objects.size).toBe(objects);
  });

  test("a photo that loses the day's last place to another in flight is refused, and its objects go", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    await withMatchingConfig(ctx.client, { message_photos_per_day: 1 });
    // Another photo of A's commits between the early count and the transaction.
    const db = landingAfter(ctx, EARLY_COUNT, async () => {
      await ctx.client.query(
        `INSERT INTO photo (account_id, key, blurhash, width, height, state, purpose, position, created_at)
         VALUES ($1, md5('elsewhere'), 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 10, 10, 'approved', 'message', NULL, $2)`,
        [a.accountId, NOON],
      );
    });
    const { app, store } = await appWith(ctx, { db, now: () => NOON });
    await withMatchingConfig(ctx.client, { message_photos_per_day: 1 });
    const res = await sendPhoto(app, a, id, form(await fixtureJpeg({ exif: false })));
    expect(res.status).toBe(429);
    expect(await codeOf(res)).toBe("message_photo_budget_exceeded");
    expect(store.objects.size).toBe(0);
  });

  test("A resend with the same id stores one photo and one message", async ({ ctx }) => {
    const moderator = scriptedModerator(checked([]));
    const { app, store } = await appWith(ctx, { moderator });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const clientId = randomUUID();
    const bytes = await fixtureJpeg({ exif: false });
    const first = await sendPhoto(app, a, id, form(bytes, { clientId, caption: "Kesällä" }));
    const again = await sendPhoto(app, a, id, form(bytes, { clientId, caption: "Kesällä" }));
    expect([first.status, again.status]).toEqual([201, 200]);
    const [sent, resent] = [
      ChatMessage.parse(await first.json()),
      ChatMessage.parse(await again.json()),
    ];
    expect(resent.id).toBe(sent.id);
    expect(resent.photo?.urls).not.toBeNull();
    // The resend was answered before any picture was read.
    expect(moderator.seen).toHaveLength(1);
    const counts = await ctx.client.query(
      `SELECT (SELECT count(*)::int FROM photo WHERE account_id = $1 AND purpose = 'message') AS photos,
              (SELECT count(*)::int FROM message WHERE conversation_id = $2) AS messages`,
      [a.accountId, id],
    );
    expect(counts.rows[0]).toEqual({ photos: 1, messages: 1 });
    expect(store.objects.size).toBe(3);
    // The other side's id is not B's to resend.
    const foreign = await sendPhoto(app, b, id, form(bytes, { clientId }));
    expect(foreign.status).toBe(400);
    expect(await codeOf(foreign)).toBe("validation_failed");
  });

  test("a resend that the early look missed is answered with the stored message inside the transaction, and the other side's id is refused there", async ({
    ctx,
  }) => {
    const moderator = scriptedModerator(checked([]));
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const clientId = randomUUID();
    const bytes = await fixtureJpeg({ exif: false });
    const { app, store } = await appWith(ctx, { moderator });
    expect((await sendPhoto(app, a, id, form(bytes, { clientId }))).status).toBe(201);
    // The early look by the client id finds nothing, as if the first send had not yet committed.
    const blind = (): Queryable => {
      let hidden = true;
      return {
        async query(text: string, values?: unknown[]) {
          if (hidden && text.includes("AND m.client_id = $3")) {
            hidden = false;
            return { rows: [], rowCount: 0 };
          }
          return ctx.client.query(text, values);
        },
      } as unknown as Queryable;
    };
    const late = await appWith(ctx, { moderator, db: blind() });
    const again = await sendPhoto(late.app, a, id, form(bytes, { clientId }));
    expect(again.status).toBe(200);
    // The same content: the first photo's row keeps its objects.
    expect(store.objects.size).toBe(3);
    const other = await appWith(ctx, { moderator, db: blind() });
    const foreign = await sendPhoto(other.app, b, id, form(await fixturePng(), { clientId }));
    expect(foreign.status).toBe(400);
    expect(await codeOf(foreign)).toBe("validation_failed");
    expect(other.store.objects.size).toBe(0);
    const photos = await ctx.client.query(
      "SELECT count(*)::int AS n FROM photo WHERE purpose = 'message'",
    );
    expect(photos.rows[0]).toEqual({ n: 1 });
  });

  test("The caption follows the text's rules, before any picture is read", async ({ ctx }) => {
    const moderator = scriptedModerator(checked([]));
    const { app, store } = await appWith(ctx, { moderator });
    await withMatchingConfig(ctx.client, { message_max_length: 10 });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const bytes = await fixturePng();
    const long = await sendPhoto(app, a, id, form(bytes, { caption: "Kaunis ilta järvellä" }));
    expect(long.status).toBe(400);
    expect(await codeOf(long)).toBe("message_too_long");
    const contact = await sendPhoto(app, a, id, form(bytes, { caption: "0401234567" }));
    expect(contact.status).toBe(400);
    expect(await codeOf(contact)).toBe("contact_details");
    expect(moderator.seen).toEqual([]);
    await nothingStored(ctx, store);
    // A blank caption is none.
    const blank = await sendPhoto(app, a, id, form(bytes, { caption: "   " }));
    expect(blank.status).toBe(201);
    expect(ChatMessage.parse(await blank.json()).body).toBeNull();
  });

  test("A closed conversation takes no photo, and nothing is stored", async ({ ctx }) => {
    const moderator = scriptedModerator(checked([]));
    const { app, store, logger, media } = await appWith(ctx, { moderator });
    const a = await person(ctx, "Aino");
    const bytes = await fixturePng();
    const block = async (blocker: Person, blocked: Person) => {
      await cardShown(ctx.client, blocker.accountId, blocked.accountId);
      const res = await app.request("/blocks", {
        method: "POST",
        headers: { ...blocker.headers, "content-type": "application/json" },
        body: JSON.stringify({ accountId: blocked.accountId }),
      });
      expect(res.status).toBe(204);
    };
    // Closed by an unmatch.
    const b = await person(ctx, "Bea");
    const closed = await conversationBetween(ctx.client, a.accountId, b.accountId);
    await ctx.client.query(
      "UPDATE conversation SET closed_at = now(), closed_how = 'unmatch', closed_by = 'b' WHERE id = $1",
      [closed],
    );
    const unmatched = await sendPhoto(app, a, closed, form(bytes));
    expect([unmatched.status, await codeOf(unmatched)]).toEqual([409, "conversation_closed"]);
    // A block by the other, and by the sender, who no longer sees it.
    const c = await person(ctx, "Cia");
    const blockedBy = await conversationBetween(ctx.client, a.accountId, c.accountId);
    await block(c, a);
    expect((await sendPhoto(app, a, blockedBy, form(bytes))).status).toBe(409);
    const d = await person(ctx, "Dan");
    const blocking = await conversationBetween(ctx.client, a.accountId, d.accountId);
    await block(a, d);
    expect((await sendPhoto(app, a, blocking, form(bytes))).status).toBe(404);
    // The counterpart erased.
    const e = await person(ctx, "Eva");
    const erased = await conversationBetween(ctx.client, a.accountId, e.accountId);
    await eraseAccount({ db: ctx.client, logger, now: () => new Date(), media }, e.accountId);
    expect((await sendPhoto(app, a, erased, form(bytes))).status).toBe(409);
    expect(moderator.seen).toEqual([]);
    await nothingStored(ctx, store);
  });

  test("a block or a sanction that lands while the photo is processed refuses it inside the transaction, and its objects go", async ({
    ctx,
  }) => {
    const moderator = scriptedModerator(checked([]));
    const a = await person(ctx, "Aino");
    const bytes = await fixtureJpeg({ exif: false });
    const blockRow = (blocker: string, blocked: string) =>
      ctx.client.query(
        `INSERT INTO block (blocker_identity_id, blocked_identity_id)
         SELECT (SELECT identity_id FROM account WHERE id = $1), (SELECT identity_id FROM account WHERE id = $2)`,
        [blocker, blocked],
      );
    const cases: Array<[string, (other: string) => Promise<unknown>, number]> = [
      ["closed by the other's block", (other) => blockRow(other, a.accountId), 409],
      ["hidden by the sender's own block", (other) => blockRow(a.accountId, other), 404],
      [
        "the sender suspended",
        () =>
          ctx.client.query("UPDATE account SET state = 'suspended' WHERE id = $1", [a.accountId]),
        404,
      ],
    ];
    for (const [, land, status] of cases) {
      const other = await person(ctx, "Bea");
      const id = await conversationBetween(ctx.client, a.accountId, other.accountId);
      const db = landingAfter(ctx, EARLY_COUNT, async () => {
        await land(other.accountId);
      });
      const { app, store } = await appWith(ctx, { moderator, db });
      const res = await sendPhoto(app, a, id, form(bytes));
      expect(res.status).toBe(status);
      expect(store.objects.size).toBe(0);
    }
  });

  test("A message photo is nobody's profile photo, and a profile photo never a message's", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, { moderator: scriptedModerator(checked([])) });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const res = await sendPhoto(app, a, id, form(await fixtureJpeg({ exif: false })));
    const photoId = ChatMessage.parse(await res.json()).photo?.photoId;
    if (!photoId) throw new Error("no photo");

    // A's profile photos are there, and the message photo is none of them.
    const mine = PhotoList.parse(
      await (await app.request("/photos", { headers: a.headers })).json(),
    );
    expect(mine.photos.length).toBeGreaterThan(0);
    expect(mine.photos.map((p) => p.id)).not.toContain(photoId);
    const card = CardPreviewResponse.parse(
      await (await app.request("/profile/card", { headers: a.headers })).json(),
    );
    expect(JSON.stringify(card)).not.toContain(photoId);
    const list = ConversationList.parse(
      await (await app.request("/conversations", { headers: b.headers })).json(),
    );
    const counterpart = list.open[0]?.counterpart;
    expect(counterpart && !counterpart.deleted ? counterpart.thumb?.photoId : null).not.toBe(
      photoId,
    );
    for (const [method, path, body] of [
      ["GET", `/photos/${photoId}/thumb`, undefined],
      ["GET", `/photos/${photoId}/full`, undefined],
      ["PUT", `/photos/${photoId}/caption`, { caption: null }],
      ["POST", `/photos/${photoId}/appeal`, undefined],
      ["DELETE", `/photos/${photoId}`, undefined],
    ] as const) {
      const answer = await app.request(path, {
        method,
        headers: { ...a.headers, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect([path, method, answer.status]).toEqual([path, method, 404]);
    }
    // A message that names a profile photo shows none: the read asks for a message photo.
    const c = await person(ctx, "Cia");
    const profilePhoto = await cardShown(ctx.client, c.accountId, a.accountId);
    const other = await conversationBetween(ctx.client, a.accountId, c.accountId, {
      messages: [{ from: "a", body: "Kuva" }],
    });
    await ctx.client.query(
      "UPDATE message SET kind = 'photo', photo_id = $2 WHERE conversation_id = $1 AND seq = 1",
      [other, profilePhoto],
    );
    const [named] = (await pageOf(app, c, other)).messages;
    expect(named).toMatchObject({ kind: "photo", photo: null });
  });

  test("the profile's photo routes count, order and close gaps among profile photos only, a message photo beside them", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, { moderator: scriptedModerator(checked([])) });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const res = await sendPhoto(app, a, id, form(await fixturePng(300, 300)));
    const sent = ChatMessage.parse(await res.json()).photo?.photoId;
    if (!sent) throw new Error("no photo");
    const profile = async () =>
      (
        await ctx.client.query<{ id: string; position: number }>(
          "SELECT id, position FROM photo WHERE account_id = $1 AND purpose = 'profile' ORDER BY position",
          [a.accountId],
        )
      ).rows;
    const three = await profile();
    expect(three.map((p) => p.position)).toEqual([0, 1, 2]);
    const upload = (bytes: Uint8Array) => {
      const body = new FormData();
      body.append(
        "photo",
        new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: "image/jpeg" }),
        "p.jpg",
      );
      return Promise.resolve(app.request("/photos", { method: "POST", headers: a.headers, body }));
    };

    // Room for one more of four: the message photo takes none of it, nor a position.
    await withMatchingConfig(ctx.client, { max_photos: 4 });
    const added = await upload(await fixtureJpeg({ width: 600, height: 800, exif: false }));
    expect(added.status).toBe(201);
    const fourth = Photo.parse(await added.json());
    expect(fourth.position).toBe(3);
    const over = await upload(await fixtureJpeg({ width: 601, height: 800, exif: false }));
    expect([over.status, await codeOf(over)]).toEqual([409, "photo_limit"]);

    // The order names the four profile photos; the message photo is not one to name.
    const order = [...three.map((p) => p.id), fourth.id].reverse();
    const reordered = await app.request("/photos/order", {
      method: "PUT",
      headers: { ...a.headers, "content-type": "application/json" },
      body: JSON.stringify({ order }),
    });
    expect(reordered.status).toBe(200);
    expect(PhotoList.parse(await reordered.json()).photos.map((p) => [p.id, p.position])).toEqual(
      order.map((photoId, position) => [photoId, position]),
    );
    const named = await app.request("/photos/order", {
      method: "PUT",
      headers: { ...a.headers, "content-type": "application/json" },
      body: JSON.stringify({ order: [...order, sent] }),
    });
    expect([named.status, await codeOf(named)]).toEqual([400, "photo_order_invalid"]);

    // A deletion closes the gap among the profile photos, and leaves the message photo without one.
    const removed = await app.request(`/photos/${order[0]}`, {
      method: "DELETE",
      headers: a.headers,
    });
    expect(removed.status).toBe(204);
    expect(await profile()).toEqual(
      order.slice(1).map((photoId, position) => ({ id: photoId, position })),
    );
    const message = await ctx.client.query("SELECT purpose, position FROM photo WHERE id = $1", [
      sent,
    ]);
    expect(message.rows).toEqual([{ purpose: "message", position: null }]);
  });

  test("Fetches of a message photo are logged and never spend the day's budget", async ({
    ctx,
  }) => {
    let clock = NOON;
    const { app } = await appWith(ctx, {
      moderator: scriptedModerator(checked([])),
      now: () => clock,
    });
    await withMatchingConfig(ctx.client, {
      photo_fetches_per_day: { thumb: 1, card: 5, full: 5 },
    });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const c = await person(ctx, "Cia");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    expect((await sendPhoto(app, a, id, form(await fixtureJpeg({ exif: false })))).status).toBe(
      201,
    );
    // Read three times within the window: the same URLs, logged once.
    const reads = [];
    for (let i = 0; i < 3; i += 1) reads.push((await pageOf(app, b, id)).messages[0]?.photo?.urls);
    expect(reads[0]).not.toBeNull();
    expect(reads[1]).toEqual(reads[0]);
    expect(reads[2]).toEqual(reads[0]);
    const shown = await cardShown(ctx.client, b.accountId, c.accountId);
    expect((await app.request(`/photos/${shown}/thumb`, { headers: b.headers })).status).toBe(200);
    const spent = await app.request(`/photos/${shown}/thumb`, { headers: b.headers });
    expect([spent.status, await codeOf(spent)]).toEqual([429, "photo_budget_exceeded"]);
    const rows = await ctx.client.query<{ purpose: string; n: number }>(
      `SELECT purpose, count(*)::int AS n FROM photo_access WHERE account_id = $1
       GROUP BY purpose ORDER BY purpose`,
      [b.accountId],
    );
    expect(rows.rows).toEqual([
      { purpose: "profile", n: 1 },
      { purpose: "message", n: 2 },
    ]);
    // The next five minutes: new URLs, logged again.
    clock = new Date(NOON.getTime() + 5 * 60 * 1000);
    const later = (await pageOf(app, b, id)).messages[0]?.photo?.urls;
    expect(later?.thumb).not.toBe(reads[0]?.thumb);
    expect(new Date(later?.expiresAt ?? 0).getTime() - clock.getTime()).toBe(20 * 60 * 1000);
    const again = await ctx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM photo_access WHERE account_id = $1 AND purpose = 'message'",
      [b.accountId],
    );
    expect(again.rows[0]?.n).toBe(4);
  });

  test("The sender's erasure leaves the photo removed for the other, and its objects go", async ({
    ctx,
  }) => {
    const { app, store, logger, media } = await appWith(ctx, {
      moderator: scriptedModerator(checked([])),
    });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    expect(
      (await sendPhoto(app, a, id, form(await fixtureJpeg({ exif: false }), { caption: "Moi" })))
        .status,
    ).toBe(201);
    expect(store.objects.size).toBe(3);
    await eraseAccount({ db: ctx.client, logger, now: () => new Date(), media }, a.accountId);
    const [message] = (await pageOf(app, b, id)).messages;
    expect(message).toMatchObject({ kind: "photo", body: "Moi", photo: null });
    expect(store.objects.size).toBe(0);
  });

  test("The erasure's hold keeps only what it names, and nothing names a photo yet", async ({
    ctx,
  }) => {
    const { app, store, logger } = await appWith(ctx, {
      moderator: scriptedModerator(checked([])),
    });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const ids: string[] = [];
    for (const width of [300, 301]) {
      const res = await sendPhoto(app, a, id, form(await fixturePng(width, 300)));
      ids.push(ChatMessage.parse(await res.json()).photo?.photoId ?? "");
    }
    const [held = "", other = ""] = ids;
    expect(other).not.toBe(held);
    const before = new Map(
      (
        await ctx.client.query<{ id: string; key: string }>(
          "SELECT id, key FROM photo WHERE account_id = $1",
          [a.accountId],
        )
      ).rows.map((r) => [r.id, r.key]),
    );
    const heldKey = before.get(held) ?? "";
    const objectsOf = (key: string) =>
      (["card", "full", "thumb"] as const).map((variant) => objectKey(key, variant));
    const objects = () => [...store.objects.keys()].sort();
    expect(objects()).toEqual(
      [...objectsOf(heldKey), ...objectsOf(before.get(other) ?? "")].sort(),
    );
    const removeObjects = (keys: string[]) =>
      deleteOrphanedObjects({ db: ctx.client, store, logger }, keys, { accountId: a.accountId });

    const kept = await erasePhotosOfAccount(ctx.client, a.accountId, [held]);
    // Every photo of the account but the held one: the profile's and the other message photo.
    expect(kept.photos).toBe(before.size - 1);
    const left = await ctx.client.query<{ id: string }>(
      "SELECT id FROM photo WHERE account_id = $1",
      [a.accountId],
    );
    expect(left.rows.map((r) => r.id)).toEqual([held]);
    // The content keys handed on for the objects are the others', never the held photo's,
    // and after the commit the held photo keeps its objects while the other's go.
    expect([...kept.keys].sort()).toEqual(
      [...before].flatMap(([photoId, key]) => (photoId === held ? [] : [key])).sort(),
    );
    expect(kept.keys).not.toContain(heldKey);
    await removeObjects(kept.keys);
    expect(objects()).toEqual(objectsOf(heldKey).sort());

    // Without a hold: everything goes, the objects too.
    const all = await erasePhotosOfAccount(ctx.client, a.accountId);
    expect(all).toMatchObject({ photos: 1, keys: [heldKey] });
    await removeObjects(all.keys);
    expect(store.objects.size).toBe(0);
  });

  test("The export carries the person's own photos and the counterpart's as a kind, a time and a length", async ({
    ctx,
  }) => {
    const { app, store, media } = await appWith(ctx, { moderator: scriptedModerator(checked([])) });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const mine = ChatMessage.parse(
      await (
        await sendPhoto(app, a, id, form(await fixturePng(300, 300), { caption: "Aamulla" }))
      ).json(),
    );
    const theirs = `Illalla ${MARK}`;
    const sentByB = await sendPhoto(
      app,
      b,
      id,
      form(await fixturePng(301, 300), { caption: theirs }),
    );
    expect(sentByB.status).toBe(201);
    const theirPhoto = ChatMessage.parse(await sentByB.json()).photo?.photoId ?? "";
    const exported = await openExport(await app.request("/account/export", { headers: a.headers }));
    const file = `photos/${mine.photo?.photoId}.webp`;
    // The line carries the photo as a profile photo's entry is: the file, the
    // check's outcome and its description, in keys and in words.
    expect(exported.document.conversations[0]?.mine).toEqual([
      {
        at: expect.any(String),
        kind: "photo",
        body: "Aamulla",
        photo: {
          file,
          review: { decision: "approved", reason: null, decidedByStaff: false, decidedAt: null },
          description: mine.photo?.description,
          descriptionText: expect.stringMatching(/\S/),
        },
      },
    ]);
    expect(mine.photo?.description).toMatchObject({ people: 1 });
    expect(exported.document.conversations[0]?.theirs).toEqual([
      { at: expect.any(String), kind: "photo", length: [...theirs].length },
    ]);
    const fullKey = [...store.objects.keys()].find(
      (key) =>
        key.endsWith("full.webp") &&
        store.objects.get(key)?.length === exported.files.get(file)?.length,
    );
    expect(fullKey).toBeDefined();
    // Never the counterpart's words, nor their picture, read before the contract drops a key it does not name.
    expect(exported.raw).not.toContain(MARK);
    expect(exported.raw).not.toContain(theirPhoto);
    expect(Object.keys(JSON.parse(exported.raw).conversations[0].theirs[0])).toEqual([
      "at",
      "kind",
      "length",
    ]);
    expect([...exported.files.keys()].filter((path) => path.startsWith("photos/"))).toEqual([file]);
    // Of a long history, the newest hundred photos' files only.
    const c = await person(ctx, "Cia");
    const ids: string[] = [];
    for (let i = 0; i < EXPORT_MESSAGE_PHOTOS_MAX + 1; i += 1) {
      const key = createHash("sha256").update(`sent ${i}`).digest("hex");
      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO photo (account_id, key, blurhash, width, height, state, purpose, position, created_at)
         VALUES ($1, $2, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 10, 10, 'approved', 'message', NULL,
                 now() - make_interval(mins => $3)) RETURNING id`,
        [c.accountId, key, EXPORT_MESSAGE_PHOTOS_MAX + 1 - i],
      );
      ids.push(rows[0]?.id ?? "");
      store.objects.set(`media/${key}/full.webp`, new Uint8Array([i % 256]));
    }
    const { logger } = await captureLogger();
    const many = await exportPhotos(
      { ...media, db: ctx.client, logger, now: () => new Date() },
      c.accountId,
    );
    const attached = many.files.map((f) => f.path);
    expect(attached).toHaveLength(EXPORT_MESSAGE_PHOTOS_MAX);
    expect(attached).toContain(`photos/${ids.at(-1)}.webp`);
    expect(attached).not.toContain(`photos/${ids[0]}.webp`);
    // Every sent photo keeps its entry; the oldest names no file.
    expect(many.sent.size).toBe(EXPORT_MESSAGE_PHOTOS_MAX + 1);
    expect(many.sent.get(ids[0] ?? "")?.file).toBeNull();
    expect(many.sent.get(ids.at(-1) ?? "")?.file).toBe(`photos/${ids.at(-1)}.webp`);
  });

  test('the event says a photo and its caption\'s length as a band, "0" without one', async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, { moderator: scriptedModerator(checked([])) });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const consent = await app.request("/consents", {
      method: "POST",
      headers: { ...a.headers, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "research",
        version: CURRENT_CONSENT_VERSIONS.research,
        locale: "fi",
      }),
    });
    expect(consent.status).toBe(200);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    expect((await sendPhoto(app, a, id, form(await fixturePng(300, 300)))).status).toBe(201);
    expect(
      (await sendPhoto(app, a, id, form(await fixturePng(301, 300), { caption: `Hei ${MARK}` })))
        .status,
    ).toBe(201);
    const events = await ctx.client.query<{ props: { kind: string; length: string } }>(
      "SELECT props FROM events WHERE name = 'message_sent' ORDER BY props->>'firstInConversation' DESC",
    );
    expect(events.rows.map((r) => [r.props.kind, r.props.length])).toEqual([
      ["photo", "0"],
      ["photo", "1-20"],
    ]);
    expect(JSON.stringify(events.rows)).not.toContain(MARK);
  });
});

describe("what a failure leaves behind", () => {
  test("a statement that fails inside the transaction writes nothing, and the photo's objects go", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const db = {
      async query(text: string, values?: unknown[]) {
        if (text.includes("INSERT INTO message")) throw new Error("the disk is full");
        return ctx.client.query(text, values);
      },
    } as unknown as Queryable;
    const { app, store } = await appWith(ctx, { moderator: scriptedModerator(checked([])), db });
    const res = await sendPhoto(app, a, id, form(await fixtureJpeg({ exif: false })));
    expect([res.status, await codeOf(res)]).toEqual([500, "internal_error"]);
    expect(store.objects.size).toBe(0);
  });

  test("a store that refuses the variants answers an error, and keeps none of them", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const { app, store, media } = await appWith(ctx, { moderator: scriptedModerator(checked([])) });
    const put = media.store.put.bind(media.store);
    media.store.put = async (key, body, type) => {
      if (key.endsWith("/full.webp")) throw new Error("the bucket said no");
      return put(key, body, type);
    };
    const res = await sendPhoto(app, a, id, form(await fixtureJpeg({ exif: false })));
    expect(res.status).toBe(500);
    expect(store.objects.size).toBe(0);
    await nothingStored(ctx, store);
  });

  test("a check that fails for any other reason answers an error, and nothing is stored", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const db = {
      async query(text: string, values?: unknown[]) {
        // The check's own lines, read after the picture is processed.
        if (
          Array.isArray(values?.[0]) &&
          (values[0] as string[]).includes("photo_moderation_label_threshold")
        ) {
          throw new Error("the database went away");
        }
        return ctx.client.query(text, values);
      },
    } as unknown as Queryable;
    const { app, store } = await appWith(ctx, { moderator: scriptedModerator(checked([])), db });
    const res = await sendPhoto(app, a, id, form(await fixtureJpeg({ exif: false })));
    expect(res.status).toBe(500);
    await nothingStored(ctx, store);
  });

  test("the export leaves out a sent photo whose file is gone, and keeps its line without a file", async ({
    ctx,
  }) => {
    const { app, store } = await appWith(ctx, { moderator: scriptedModerator(checked([])) });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    expect((await sendPhoto(app, a, id, form(await fixturePng(300, 300)))).status).toBe(201);
    store.objects.clear();
    const exported = await openExport(await app.request("/account/export", { headers: a.headers }));
    expect(exported.document.conversations[0]?.mine).toEqual([
      {
        at: expect.any(String),
        kind: "photo",
        body: "",
        // The line and the photo's entry stay, naming no file the zip does not carry.
        photo: expect.objectContaining({
          file: null,
          review: expect.objectContaining({ decision: "approved" }),
        }),
      },
    ]);
    expect([...exported.files.keys()].filter((path) => path.startsWith("photos/"))).toEqual([]);
  });
});

describe("the photo route's checklist", () => {
  test("unauthenticated: no token, and an expired one, read no body", async ({ ctx }) => {
    const { app } = await appWith(ctx, { moderator: scriptedModerator(checked([])) });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const none = await app.request(`/conversations/${id}/photos`, {
      method: "POST",
      body: form(await fixturePng()),
    });
    expect([none.status, await codeOf(none)]).toEqual([401, "unauthenticated"]);
    await ctx.client.query(
      "UPDATE session SET access_expires_at = now() - interval '1 second' WHERE account_id = $1",
      [a.accountId],
    );
    const expired = await sendPhoto(app, a, id, form(await fixturePng()));
    expect([expired.status, await codeOf(expired)]).toEqual([401, "session_expired"]);
  });

  test("validation: no picture, a picture of another type, a malformed client id, an unknown field, a caption with NUL", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, { moderator: scriptedModerator(checked([])) });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const noPicture = new FormData();
    noPicture.append("clientId", randomUUID());
    const bodies = [
      noPicture,
      form(await fixtureGif(), { type: "image/gif" }),
      form(await fixturePng(), { clientId: "not-a-uuid" }),
      form(await fixturePng(), { extra: ["note", "x"] }),
      form(await fixturePng(), { caption: "a\u0000b" }),
    ];
    for (const body of bodies) {
      const res = await sendPhoto(app, a, id, body);
      expect([res.status, await codeOf(res)]).toEqual([400, "validation_failed"]);
    }
  });

  test("the pipeline's refusals: not a picture, too many pixels, over 10 MB", async ({ ctx }) => {
    const { app, store } = await appWith(ctx, { moderator: scriptedModerator(checked([])) });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const text = new TextEncoder().encode(`not a picture ${MARK}`);
    const unsupported = await sendPhoto(app, a, id, form(text));
    expect([unsupported.status, await codeOf(unsupported)]).toEqual([415, "photo_unsupported"]);
    const huge = await sendPhoto(app, a, id, form(fixtureHugeJpegHeader()));
    expect([huge.status, await codeOf(huge)]).toEqual([422, "photo_too_many_pixels"]);
    const big = await sendPhoto(app, a, id, form(new Uint8Array(PHOTO_MAX_BYTES + 1)));
    expect([big.status, await codeOf(big)]).toEqual([413, "payload_too_large"]);
    expect(store.objects.size).toBe(0);
  });

  test("busy and unavailable: the pipeline at capacity, no object storage", async ({ ctx }) => {
    const { app } = await appWith(ctx, {
      moderator: scriptedModerator(checked([])),
      concurrency: 1,
    });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const bytes = await fixtureJpeg({ width: 1000, height: 1000, exif: false });
    const [one, two] = await Promise.all([
      sendPhoto(app, a, id, form(bytes)),
      sendPhoto(app, a, id, form(bytes)),
    ]);
    expect([one.status, two.status].sort()).toEqual([201, 503]);
    const busy = one.status === 503 ? one : two;
    expect([busy.headers.get("retry-after"), await codeOf(busy)]).toEqual(["5", "media_busy"]);
    const bare = await appWith(ctx, { media: false });
    const none = await sendPhoto(bare.app, a, id, form(bytes));
    expect([none.status, await codeOf(none)]).toEqual([503, "media_unavailable"]);
  });

  test("a photo and a text share the minute's messages", async ({ ctx }) => {
    const { app } = await appWith(ctx, { moderator: scriptedModerator(checked([])) });
    await withMatchingConfig(ctx.client, { messages_per_minute: 1 });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const text = await app.request(`/conversations/${id}/messages`, {
      method: "POST",
      headers: { ...a.headers, "content-type": "application/json" },
      body: JSON.stringify({ clientId: randomUUID(), body: "Hei" }),
    });
    expect(text.status).toBe(201);
    const photo = await sendPhoto(app, a, id, form(await fixturePng()));
    expect([photo.status, await codeOf(photo)]).toEqual([429, "message_budget_exceeded"]);
  });

  test("no caption, no picture's words: nothing of either reaches a log line", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx, { moderator: scriptedModerator(checked([])) });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    expect(
      (await sendPhoto(app, a, id, form(await fixturePng(), { caption: `Hei ${MARK}` }))).status,
    ).toBe(201);
    await pageOf(app, b, id);
    expect(JSON.stringify(logs())).not.toContain(MARK);
  });
});
