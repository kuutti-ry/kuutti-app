import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { fixtureJpeg, testMediaDeps } from "../test/media.ts";
import {
  decideModeration,
  type Inspection,
  type Moderator,
  moderatePhoto,
  NO_FACE,
  NOT_CHECKED,
  RECHECK_AFTER_MS,
  storedLabels,
  sweepPendingPhotos,
  tipLabelsFrom,
} from "./moderation.ts";
import { objectKey } from "./store.ts";

// The automatic check (#49, features/media/moderation.feature): the decision
// is pure and tested over the rows of the outline; the rest runs through the
// upload with a moderator that answers what Rekognition would, recorded, and
// never a real call.

const inspection = (
  labels: string,
  faces: string,
  tipLabels: Inspection["tipLabels"] = [],
): Inspection => ({
  checked: labels !== "unchecked",
  labels:
    labels === "none" || labels === "unchecked"
      ? []
      : labels.split(",").map((part) => {
          const match = /^\s*(.+?)\s+(\d+)\s*$/.exec(part);
          if (!match) throw new Error(`bad label ${part}`);
          return { name: match[1] ?? "", parentName: "", confidence: Number(match[2]) };
        }),
  tipLabels,
  faceConfidences: faces === "none" ? [] : faces.split(",").map(Number),
  modelVersion: "7.0",
  calls: 3,
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

  it("ignores tip signals when deciding the queue", () => {
    const decided = decideModeration(
      inspection("none", "99", [
        { name: "Mirror", parentName: "", confidence: 99 },
        { name: "TightCrop", parentName: "Face", confidence: 80 },
        { name: "Group", parentName: "Face", confidence: 100 },
      ]),
      { labelThreshold: 60, faceThreshold: 90 },
    );
    expect(decided).toEqual({ decision: "approved", flagged: [], faces: 1 });
  });
});

describe("tip signals for photo_review", () => {
  it("maps scene labels and face attributes without inventing Gender", () => {
    expect(
      tipLabelsFrom(
        [{ Name: "Mirror", Parents: [{ Name: "Furniture" }], Confidence: 88.4 }],
        [
          {
            Confidence: 99,
            BoundingBox: { Width: 0.7, Height: 0.7, Left: 0.1, Top: 0.1 },
            Sunglasses: { Value: true, Confidence: 91 },
            Quality: { Brightness: 40.2, Sharpness: 12.5 },
          },
          { Confidence: 80, BoundingBox: { Width: 0.1, Height: 0.1 } },
        ],
      ),
    ).toEqual([
      { name: "Mirror", parentName: "Furniture", confidence: 88.4 },
      { name: "Sunglasses", parentName: "Face", confidence: 91 },
      { name: "TightCrop", parentName: "Face", confidence: 49 },
      { name: "Brightness", parentName: "Face", confidence: 40.2 },
      { name: "Sharpness", parentName: "Face", confidence: 12.5 },
      { name: "Group", parentName: "Face", confidence: 100 },
    ]);
  });

  it("stores moderation labels ahead of tip signals, capped", () => {
    const labels = Array.from({ length: 48 }, (_, i) => ({
      name: `M${i}`,
      parentName: "",
      confidence: 50,
    }));
    const tipLabels = [
      { name: "Mirror", parentName: "", confidence: 90 },
      { name: "Bathroom", parentName: "", confidence: 80 },
      { name: "Group", parentName: "Face", confidence: 100 },
    ];
    expect(storedLabels({ ...inspection("none", "99", tipLabels), labels })).toHaveLength(50);
    expect(storedLabels({ ...inspection("none", "99", tipLabels), labels }).at(-1)?.name).toBe(
      "Bathroom",
    );
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
      rekognitionCalls: 3,
    });
  });

  test("Tip signals are recorded with the review and do not queue the photo", async ({ ctx }) => {
    const moderator = scripted(
      inspection("none", "99", [
        { name: "Bathroom", parentName: "", confidence: 77 },
        { name: "Brightness", parentName: "Face", confidence: 20 },
      ]),
    );
    const { app } = await appWith(ctx, moderator);
    const me = await signedInAccount(ctx.client);
    const res = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 900, height: 1200, exif: false })),
    });
    expect(res.status).toBe(201);
    const photo = await res.json();
    expect(photo.state).toBe("approved");
    const review = await ctx.client.query(
      "SELECT decision, flagged, labels FROM photo_review WHERE photo_id = $1",
      [photo.id],
    );
    expect(review.rows[0]).toEqual({
      decision: "approved",
      flagged: [],
      labels: [
        { name: "Bathroom", parentName: "", confidence: 77 },
        { name: "Brightness", parentName: "Face", confidence: 20 },
      ],
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
