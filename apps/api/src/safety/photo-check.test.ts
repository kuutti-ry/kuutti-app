import { describe, expect } from "vitest";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { type TestContext, test } from "../test/harness.ts";
import {
  closerLookOf,
  deletePhotoCheckNotesOfAccount,
  listPhotoCheckNotes,
  NOTE_RETENTION_DAYS,
  prunePhotoCheckNotes,
  recordPhotoCheckNote,
  withdrawPhotoCheckNote,
} from "./photo-check.ts";

// The notes of the photo check and the closer look they lead to (#253,
// features/safety/photo-check-notes.feature): the scenarios run through the
// upload, the panel and the export (media/moderation.test.ts,
// identity/erasure.test.ts); these are the edges of the window and the scoping.

const DAY = 86_400_000;
const T = new Date("2026-10-01T12:00:00Z");
const daysFrom = (base: Date, days: number) => new Date(base.getTime() + days * DAY);

const note = (ctx: TestContext, accountId: string, at: Date) =>
  ctx.client.query(
    "INSERT INTO photo_check_note (account_id, kind, at) VALUES ($1, 'nudity', $2)",
    [accountId, at],
  );

describe("the closer look", () => {
  test("one note, or two further apart than the window, start none", async ({ ctx }) => {
    const me = await signedInAccount(ctx.client);
    await note(ctx, me.accountId, daysFrom(T, -1));
    expect(await closerLookOf(ctx.client, me.accountId, T)).toEqual({ until: null, reject: 75 });
    await note(ctx, me.accountId, daysFrom(T, -32));
    expect((await closerLookOf(ctx.client, me.accountId, T)).until).toBeNull();
  });

  test("two notes exactly the window apart start one, from the second", async ({ ctx }) => {
    const me = await signedInAccount(ctx.client);
    await note(ctx, me.accountId, daysFrom(T, -35));
    await note(ctx, me.accountId, daysFrom(T, -5));
    expect((await closerLookOf(ctx.client, me.accountId, T)).until).toEqual(daysFrom(T, 25));
  });

  test("a run long over has no closer look left, and a note later than now does not count", async ({
    ctx,
  }) => {
    const me = await signedInAccount(ctx.client);
    await note(ctx, me.accountId, daysFrom(T, -45));
    await note(ctx, me.accountId, daysFrom(T, -40));
    expect((await closerLookOf(ctx.client, me.accountId, T)).until).toBeNull();
    await note(ctx, me.accountId, daysFrom(T, 1));
    await note(ctx, me.accountId, daysFrom(T, 2));
    expect((await closerLookOf(ctx.client, me.accountId, T)).until).toBeNull();
  });

  test("counts days of 24 hours across the end of summer time, whatever the session's time zone", async ({
    ctx,
  }) => {
    // Helsinki leaves summer time on 25/10/2026: thirty calendar days there are an hour longer.
    await ctx.client.query("SET LOCAL TimeZone = 'Europe/Helsinki'");
    const me = await signedInAccount(ctx.client);
    const second = new Date("2026-10-10T12:00:00Z");
    await note(ctx, me.accountId, daysFrom(second, -3));
    await note(ctx, me.accountId, second);
    const end = daysFrom(second, 30);
    expect(
      (await closerLookOf(ctx.client, me.accountId, new Date(end.getTime() - 60_000))).until,
    ).toEqual(end);
    expect((await closerLookOf(ctx.client, me.accountId, end)).until).toBeNull();
    expect(
      (await closerLookOf(ctx.client, me.accountId, new Date(end.getTime() + 1_800_000))).until,
    ).toBeNull();
  });

  test("another account's notes count for nobody else", async ({ ctx }) => {
    const me = await signedInAccount(ctx.client);
    const other = await signedInAccount(ctx.client);
    await note(ctx, other.accountId, daysFrom(T, -3));
    await note(ctx, other.accountId, daysFrom(T, -2));
    await note(ctx, me.accountId, daysFrom(T, -1));
    expect((await closerLookOf(ctx.client, me.accountId, T)).until).toBeNull();
    expect((await closerLookOf(ctx.client, other.accountId, T)).until).toEqual(daysFrom(T, 28));
  });

  test("reads its numbers from matching_config", async ({ ctx }) => {
    await withMatchingConfig(ctx.client, {
      photo_closer_look_attempts: 3,
      photo_closer_look_window_days: 10,
      photo_closer_look_days: 5,
      photo_closer_look_reject: 70,
    });
    const me = await signedInAccount(ctx.client);
    await note(ctx, me.accountId, daysFrom(T, -3));
    await note(ctx, me.accountId, daysFrom(T, -2));
    expect(await closerLookOf(ctx.client, me.accountId, T)).toEqual({ until: null, reject: 70 });
    await note(ctx, me.accountId, daysFrom(T, -1));
    expect((await closerLookOf(ctx.client, me.accountId, T)).until).toEqual(daysFrom(T, 4));
  });
});

describe("the notes themselves", () => {
  test("are recorded with their photo, listed oldest first, and withdrawn by the photo", async ({
    ctx,
  }) => {
    const me = await signedInAccount(ctx.client);
    const photo = await ctx.client.query<{ id: string }>(
      `INSERT INTO photo (account_id, key, blurhash, width, height, position)
       VALUES ($1, 'k', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 10, 10, 0) RETURNING id`,
      [me.accountId],
    );
    const photoId = photo.rows[0]?.id ?? "";
    await recordPhotoCheckNote(ctx.client, {
      accountId: me.accountId,
      photoId,
      kind: "violence",
      at: T,
    });
    await note(ctx, me.accountId, daysFrom(T, -1));
    expect(await listPhotoCheckNotes(ctx.client, me.accountId)).toEqual([
      { kind: "nudity", at: daysFrom(T, -1) },
      { kind: "violence", at: T },
    ]);
    // Only the owner's note of that photo: another account's name withdraws nothing.
    const other = await signedInAccount(ctx.client);
    expect(await withdrawPhotoCheckNote(ctx.client, { accountId: other.accountId, photoId })).toBe(
      0,
    );
    expect(await withdrawPhotoCheckNote(ctx.client, { accountId: me.accountId, photoId })).toBe(1);
    expect(await withdrawPhotoCheckNote(ctx.client, { accountId: me.accountId, photoId })).toBe(0);
    expect(await listPhotoCheckNotes(ctx.client, me.accountId)).toHaveLength(1);
  });

  test("outlive their photo's deletion, without the link", async ({ ctx }) => {
    const me = await signedInAccount(ctx.client);
    const photo = await ctx.client.query<{ id: string }>(
      `INSERT INTO photo (account_id, key, blurhash, width, height, position)
       VALUES ($1, 'k', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 10, 10, 0) RETURNING id`,
      [me.accountId],
    );
    const photoId = photo.rows[0]?.id ?? "";
    await recordPhotoCheckNote(ctx.client, {
      accountId: me.accountId,
      photoId,
      kind: "hate",
      at: T,
    });
    await ctx.client.query("DELETE FROM photo WHERE id = $1", [photoId]);
    const left = await ctx.client.query(
      "SELECT photo_id, kind FROM photo_check_note WHERE account_id = $1",
      [me.accountId],
    );
    expect(left.rows).toEqual([{ photo_id: null, kind: "hate" }]);
  });

  test("are pruned at twelve months to the day, and deleted per account", async ({ ctx }) => {
    const me = await signedInAccount(ctx.client);
    const other = await signedInAccount(ctx.client);
    await note(ctx, me.accountId, daysFrom(T, -NOTE_RETENTION_DAYS));
    await note(ctx, me.accountId, daysFrom(T, -NOTE_RETENTION_DAYS - 1 / 86_400));
    await note(ctx, other.accountId, T);
    expect(await prunePhotoCheckNotes(ctx.client, T)).toBe(1);
    expect(await listPhotoCheckNotes(ctx.client, me.accountId)).toEqual([
      { kind: "nudity", at: daysFrom(T, -NOTE_RETENTION_DAYS) },
    ]);
    expect(await deletePhotoCheckNotesOfAccount(ctx.client, me.accountId)).toBe(1);
    expect(await listPhotoCheckNotes(ctx.client, other.accountId)).toHaveLength(1);
  });
});
