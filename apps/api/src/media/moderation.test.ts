import {
  DetectFacesCommand,
  DetectModerationLabelsCommand,
  type RekognitionClient,
} from "@aws-sdk/client-rekognition";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { fixtureJpeg, fixtureWebp, testMediaDeps } from "../test/media.ts";
import {
  decideModeration,
  type Inspection,
  type Moderator,
  moderatePhoto,
  NO_FACE,
  NOT_CHECKED,
  RECHECK_AFTER_MS,
  rekognitionModerator,
  sweepPendingPhotos,
} from "./moderation.ts";
import { objectKey } from "./store.ts";

// The automatic check (#49, features/media/moderation.feature): the decision
// is pure and tested over the rows of the outline; the rest runs through the
// upload with a moderator that answers what Rekognition would, recorded, and
// never a real call.

const inspection = (labels: string, faces: string): Inspection => ({
  checked: labels !== "unchecked",
  labels:
    labels === "none" || labels === "unchecked"
      ? []
      : labels.split(",").map((part) => {
          const match = /^\s*(.+?)\s+(\d+)\s*$/.exec(part);
          if (!match) throw new Error(`bad label ${part}`);
          return { name: match[1] ?? "", parentName: "", confidence: Number(match[2]) };
        }),
  faceConfidences: faces === "none" ? [] : faces.split(",").map(Number),
  modelVersion: "7.0",
  calls: 2,
});

describe("Automatic moderation decision", () => {
  it.each([
    ["none", "99", 60, 90, "approved", "nothing"],
    ["Explicit Nudity 97", "99", 60, 90, "queued", "Explicit Nudity"],
    ["Suggestive 45", "99", 60, 90, "approved", "nothing"],
    ["Suggestive 45", "99", 40, 90, "queued", "Suggestive"],
    ["none", "none", 60, 90, "queued", NO_FACE],
    ["none", "70", 60, 90, "queued", NO_FACE],
    ["Violence 80, Explicit Nudity 61", "99", 60, 90, "queued", "Violence, Explicit Nudity"],
    ["unchecked", "none", 60, 90, "queued", NOT_CHECKED],
  ])(
    "labels %s, faces %s, thresholds %d/%d → %s (%s)",
    (labels, faces, labelThreshold, faceThreshold, outcome, flagged) => {
      const decided = decideModeration(inspection(labels, faces), {
        labelThreshold,
        faceThreshold,
      });
      expect(decided.decision).toBe(outcome);
      expect(decided.flagged).toEqual(flagged === "nothing" ? [] : flagged.split(", "));
    },
  );

  it("flags each label name once however many labels share it", () => {
    const decided = decideModeration(inspection("Suggestive 70, Suggestive 65", "99"), {
      labelThreshold: 60,
      faceThreshold: 90,
    });
    expect(decided.flagged).toEqual(["Suggestive"]);
  });
});

describe("The Rekognition adapter", () => {
  it("sends the card variant as JPEG, since Rekognition reads JPEG and PNG only", async () => {
    // The stored card is WebP (ADR-005 §2); on staging Rekognition answered
    // InvalidImageFormatException to it (09/10/2026, ADR-006 History).
    const sent: { command: string; bytes: Uint8Array }[] = [];
    const client = {
      async send(command: DetectModerationLabelsCommand | DetectFacesCommand) {
        sent.push({
          command: command.constructor.name,
          bytes: command.input.Image?.Bytes ?? new Uint8Array(),
        });
        return command instanceof DetectFacesCommand
          ? { FaceDetails: [{ Confidence: 99.5 }] }
          : { ModerationLabels: [], ModerationModelVersion: "7.0" };
      },
    };
    const inspection = await rekognitionModerator(client as unknown as RekognitionClient).inspect(
      await fixtureWebp(800, 1067),
    );
    expect(sent.map((s) => s.command).sort()).toEqual([
      "DetectFacesCommand",
      "DetectModerationLabelsCommand",
    ]);
    for (const { bytes } of sent) {
      // JPEG starts with the SOI marker and the first segment marker, and
      // carries no metadata: Rekognition receives pixels only (rule 4).
      expect(Array.from(bytes.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
      const metadata = await sharp(bytes).metadata();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect([metadata.width, metadata.height]).toEqual([800, 1067]);
    }
    expect(inspection).toMatchObject({
      checked: true,
      labels: [],
      faceConfidences: [99.5],
      calls: 2,
    });
  });
});

/** A moderator that answers a scripted inspection, or throws. */
function scripted(answer: Inspection | Error): Moderator & { seen: number[] } {
  const seen: number[] = [];
  return {
    kind: "rekognition",
    seen,
    async inspect(card) {
      seen.push(card.length);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const THRESHOLDS = { photo_moderation_label_threshold: 60, photo_moderation_face_threshold: 90 };

async function appWith(ctx: TestContext, moderator: Moderator) {
  await withMatchingConfig(ctx.client, { max_photos: 3, ...THRESHOLDS });
  const { logger, lines } = await captureLogger();
  const media = testMediaDeps();
  const app = createApp({
    config: testConfig(),
    logger,
    db: ctx.client,
    media: { ...media.deps, moderator },
  });
  return { app, store: media.store, logs: lines, logger };
}

function multipart(bytes: Uint8Array): FormData {
  const form = new FormData();
  form.append(
    "photo",
    new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: "image/jpeg" }),
    "p.jpg",
  );
  return form;
}

describe("moderation of uploads", () => {
  test("An upload is checked and the photo leaves pending with what the check saw recorded", async ({
    ctx,
  }) => {
    const moderator = scripted(inspection("Suggestive 72", "98"));
    const { app } = await appWith(ctx, moderator);
    const me = await signedInAccount(ctx.client);
    const res = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 900, height: 1200, exif: false })),
    });
    expect(res.status).toBe(201);
    const photo = await res.json();
    expect(photo.state).toBe("queued");
    expect(moderator.seen).toHaveLength(1); // the card variant, once
    const review = await ctx.client.query(
      "SELECT decision, faces, flagged, labels, model_version, decided_by FROM photo_review WHERE photo_id = $1",
      [photo.id],
    );
    expect(review.rows[0]).toEqual({
      decision: "queued",
      faces: 1,
      flagged: ["Suggestive"],
      labels: [{ name: "Suggestive", parentName: "", confidence: 72 }],
      model_version: "7.0",
      decided_by: null,
    });
    const state = await ctx.client.query("SELECT state FROM photo WHERE id = $1", [photo.id]);
    expect(state.rows[0]?.state).toBe("queued");

    // A clean picture with a face is approved without anyone looking.
    const clean = await appWith(ctx, scripted(inspection("none", "99")));
    const ok = await clean.app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 800, height: 800, exif: false })),
    });
    expect((await ok.json()).state).toBe("approved");
  });

  test("A failing check leaves the photo pending and the nightly sweep tries again", async ({
    ctx,
  }) => {
    const failing = scripted(new Error("Rekognition unavailable"));
    const { app, store, logs, logger } = await appWith(ctx, failing);
    const me = await signedInAccount(ctx.client);
    const res = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 700, height: 900, exif: false })),
    });
    expect(res.status).toBe(201);
    const photo = await res.json();
    expect(photo.state).toBe("pending");
    const reviews = await ctx.client.query("SELECT count(*) AS n FROM photo_review");
    expect(Number(reviews.rows[0]?.n)).toBe(0);
    expect(logs().some((l) => l.msg === "photo moderation failed; the photo stays pending")).toBe(
      true,
    );

    // Ten minutes later the sweep checks it from the stored card variant.
    const later = new Date(Date.now() + RECHECK_AFTER_MS + 1000);
    const working = scripted(inspection("none", "99"));
    const swept = await sweepPendingPhotos({
      db: ctx.client,
      logger,
      now: () => later,
      moderator: working,
      store,
    });
    expect(swept).toEqual({ rechecked: 1, failed: 0 });
    const key =
      (await ctx.client.query<{ key: string }>("SELECT key FROM photo WHERE id = $1", [photo.id]))
        .rows[0]?.key ?? "";
    expect(working.seen[0]).toBe(store.objects.get(objectKey(key, "card"))?.length);
    const state = await ctx.client.query("SELECT state FROM photo WHERE id = $1", [photo.id]);
    expect(state.rows[0]?.state).toBe("approved");
    // Too fresh to be swept a second time, and nothing pending anyway.
    expect(
      await sweepPendingPhotos({
        db: ctx.client,
        logger,
        now: () => new Date(),
        moderator: working,
        store,
      }),
    ).toEqual({ rechecked: 0, failed: 0 });
  });

  test("A check recorded without the photo moving is retried by the sweep, a person's decision is not", async ({
    ctx,
  }) => {
    // The record and the move are one transaction now; a row from before that
    // (or a crash between the two) must not be pending forever.
    const { app, store, logger } = await appWith(ctx, scripted(new Error("down")));
    const me = await signedInAccount(ctx.client);
    const upload = async () => {
      const res = await app.request("/photos", {
        method: "POST",
        headers: me.headers,
        body: multipart(await fixtureJpeg({ width: 700, height: 900, exif: false })),
      });
      return (await res.json()).id as string;
    };
    const halfWritten = await upload();
    const decidedByPerson = await upload();
    await ctx.client.query(
      `INSERT INTO photo_review (photo_id, labels, faces, flagged, checked_at, decision)
       VALUES ($1, '[]'::jsonb, 1, '{}', now(), 'approved')`,
      [halfWritten],
    );
    const identity = await ctx.client.query<{ identity_id: string }>(
      "SELECT identity_id FROM account WHERE id = $1",
      [me.accountId],
    );
    await ctx.client.query(
      `INSERT INTO photo_review (photo_id, labels, faces, flagged, checked_at, decision, decided_by, decided_at)
       VALUES ($1, '[]'::jsonb, 1, '{}', now(), 'rejected', $2, now())`,
      [decidedByPerson, identity.rows[0]?.identity_id],
    );
    const later = new Date(Date.now() + RECHECK_AFTER_MS + 1000);
    const working = scripted(inspection("none", "99"));
    const swept = await sweepPendingPhotos({
      db: ctx.client,
      logger,
      now: () => later,
      moderator: working,
      store,
    });
    expect(swept).toEqual({ rechecked: 1, failed: 0 });
    const states = await ctx.client.query(
      "SELECT id, state FROM photo WHERE id = ANY($1::uuid[])",
      [[halfWritten, decidedByPerson]],
    );
    expect(Object.fromEntries(states.rows.map((r) => [r.id, r.state]))).toEqual({
      [halfWritten]: "approved",
      [decidedByPerson]: "pending",
    });
  });

  test("No label name reaches a log line", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx, scripted(inspection("Explicit Nudity 97", "99")));
    const me = await signedInAccount(ctx.client);
    await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 600, height: 800, exif: false })),
    });
    const text = JSON.stringify(logs());
    expect(text).not.toContain("Explicit Nudity");
    expect(text).not.toContain("Nudity");
    const line = logs().find((l) => l.msg === "photo moderated");
    expect(line).toMatchObject({
      accountId: me.accountId,
      decision: "queued",
      labels: 1,
      flagged: 1,
      faces: 1,
      rekognitionCalls: 2,
    });
  });

  test("The automatic check never overwrites a person's decision", async ({ ctx }) => {
    const { store, logger } = await appWith(ctx, scripted(inspection("none", "99")));
    const me = await signedInAccount(ctx.client);
    // A photo a person has already rejected, with its review row.
    const photo = await ctx.client.query<{ id: string }>(
      `INSERT INTO photo (account_id, key, blurhash, width, height, state, rejection_reason, position)
       VALUES ($1, 'k1', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 800, 600, 'rejected', 'nudity', 0) RETURNING id`,
      [me.accountId],
    );
    const id = photo.rows[0]?.id ?? "";
    const staff = await ctx.client.query<{ id: string }>(
      "INSERT INTO identity (hetu_hmac) VALUES ('staff-hmac') RETURNING id",
    );
    await ctx.client.query(
      `INSERT INTO photo_review (photo_id, labels, faces, flagged, decision, decided_by, decided_at, reason)
       VALUES ($1, '[]', 0, '{}', 'rejected', $2, now(), 'nudity')`,
      [id, staff.rows[0]?.id],
    );
    const decided = await moderatePhoto(
      {
        db: ctx.client,
        logger,
        moderator: scripted(inspection("none", "99")),
        now: () => new Date(),
      },
      {
        photoId: id,
        accountId: me.accountId,
        card: await fixtureJpeg({ width: 300, height: 300, exif: false }),
      },
    );
    expect(decided?.decision).toBe("approved"); // what the machine would say
    const after = await ctx.client.query(
      "SELECT p.state, p.rejection_reason, r.decision, r.decided_by FROM photo p JOIN photo_review r ON r.photo_id = p.id WHERE p.id = $1",
      [id],
    );
    expect(after.rows[0]).toMatchObject({
      state: "rejected",
      rejection_reason: "nudity",
      decision: "rejected",
    });
    expect(after.rows[0]?.decided_by).toBe(staff.rows[0]?.id);
    void store;
  });
});
