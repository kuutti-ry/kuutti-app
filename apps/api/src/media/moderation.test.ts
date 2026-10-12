import {
  DetectFacesCommand,
  DetectLabelsCommand,
  type DetectModerationLabelsCommand,
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
  queueAllModerator,
  RECHECK_AFTER_MS,
  rekognitionModerator,
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
    // No face at all is the check's own rejection (#253); a face it is unsure of goes to a person.
    ["none", "none", 60, 90, "rejected", NO_FACE],
    ["Explicit Nudity 97", "none", 60, 90, "rejected", `Explicit Nudity, ${NO_FACE}`],
    ["none", "70", 60, 90, "queued", NO_FACE],
    // Several faces are not accepted, by the check and not a person (#206);
    // a second face under the face threshold is not sure enough to count.
    ["none", "99, 98, 95", 60, 90, "rejected", "several_faces"],
    ["none", "99, 70", 60, 90, "approved", "nothing"],
    ["Explicit Nudity 97", "99, 98", 60, 90, "rejected", "Explicit Nudity, several_faces"],
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
      // The check names a reason only when it rejects: no person, or several.
      const reason = flagged.includes("several_faces") ? "several_people" : "no_person";
      expect(decided.reason).toBe(outcome === "rejected" ? reason : undefined);
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
    ]);
  });

  it("caps the face area at the whole frame", () => {
    expect(
      tipLabelsFrom([], [{ Confidence: 99, BoundingBox: { Width: 1.2, Height: 1.1 } }]),
    ).toEqual([{ name: "TightCrop", parentName: "Face", confidence: 100 }]);
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
      { name: "TightCrop", parentName: "Face", confidence: 40 },
    ];
    expect(storedLabels({ ...inspection("none", "99", tipLabels), labels })).toHaveLength(50);
    expect(storedLabels({ ...inspection("none", "99", tipLabels), labels }).at(-1)?.name).toBe(
      "Bathroom",
    );
  });
});

describe("The Rekognition adapter", () => {
  it("sends the card variant as JPEG, since Rekognition reads JPEG and PNG only", async () => {
    // The stored card is WebP (ADR-005 §2); on staging Rekognition answered
    // InvalidImageFormatException to it (09/10/2026, ADR-006 History).
    const sent: { command: string; bytes: Uint8Array }[] = [];
    const client = {
      async send(
        command: DetectModerationLabelsCommand | DetectFacesCommand | DetectLabelsCommand,
      ) {
        sent.push({
          command: command.constructor.name,
          bytes: command.input.Image?.Bytes ?? new Uint8Array(),
        });
        if (command instanceof DetectFacesCommand) {
          return { FaceDetails: [{ Confidence: 99.5 }] };
        }
        if (command instanceof DetectLabelsCommand) {
          return { Labels: [] };
        }
        return { ModerationLabels: [], ModerationModelVersion: "7.0" };
      },
    };
    const inspection = await rekognitionModerator(client as unknown as RekognitionClient).inspect(
      await fixtureWebp(800, 1067),
    );
    expect(sent.map((s) => s.command).sort()).toEqual([
      "DetectFacesCommand",
      "DetectLabelsCommand",
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
      tipLabels: [],
      faceConfidences: [99.5],
      calls: 3,
    });
  });

  it("decides without the scene when DetectLabels fails, and never asks the scene for sunglasses", async () => {
    let filters: string[] | undefined;
    const client = {
      async send(
        command: DetectModerationLabelsCommand | DetectFacesCommand | DetectLabelsCommand,
      ) {
        if (command instanceof DetectLabelsCommand) {
          filters = command.input.Settings?.GeneralLabels?.LabelInclusionFilters;
          throw new Error("AccessDeniedException");
        }
        if (command instanceof DetectFacesCommand) {
          return {
            FaceDetails: [{ Confidence: 99.5, Sunglasses: { Value: true, Confidence: 97 } }],
          };
        }
        return { ModerationLabels: [], ModerationModelVersion: "7.0" };
      },
    };
    const inspection = await rekognitionModerator(client as unknown as RekognitionClient).inspect(
      await fixtureWebp(800, 1067),
    );
    expect(filters).toEqual(["Mirror", "Bathroom"]);
    expect(inspection).toMatchObject({
      checked: true,
      labels: [],
      tipLabels: [{ name: "Sunglasses", parentName: "Face", confidence: 97 }],
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

  test("A photo without a face is not accepted, and its owner is told why without a moderator", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx, scripted(inspection("none", "none")));
    const me = await signedInAccount(ctx.client);
    const res = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 800, height: 800, exif: false })),
    });
    expect(res.status).toBe(201);
    const photo = await res.json();
    expect(photo).toMatchObject({ state: "rejected", rejectionReason: "no_person" });
    const review = await ctx.client.query(
      "SELECT decision, reason, flagged, faces, decided_by FROM photo_review WHERE photo_id = $1",
      [photo.id],
    );
    expect(review.rows[0]).toEqual({
      decision: "rejected",
      reason: "no_person",
      flagged: ["no_face"],
      faces: 0,
      decided_by: null,
    });
    // The owner's list says why; the queue (queued photos only) never holds it.
    const mine = await app.request("/photos", { headers: me.headers });
    expect((await mine.json()).photos).toEqual([
      expect.objectContaining({
        id: photo.id,
        state: "rejected",
        rejectionReason: "no_person",
      }),
    ]);
    const queued = await ctx.client.query(
      "SELECT count(*)::int AS n FROM photo WHERE state = 'queued'",
    );
    expect(queued.rows[0]?.n).toBe(0);
    expect(logs().find((l) => l.msg === "photo moderated")).toMatchObject({
      decision: "rejected",
      faces: 0,
      flagged: 1,
    });
  });

  test("A photo with several people is not accepted, and its owner is told why without a moderator", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx, scripted(inspection("none", "99, 97")));
    const me = await signedInAccount(ctx.client);
    const res = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 800, height: 800, exif: false })),
    });
    expect(res.status).toBe(201);
    const photo = await res.json();
    expect(photo).toMatchObject({ state: "rejected", rejectionReason: "several_people" });
    const review = await ctx.client.query(
      "SELECT decision, reason, flagged, faces, decided_by FROM photo_review WHERE photo_id = $1",
      [photo.id],
    );
    expect(review.rows[0]).toEqual({
      decision: "rejected",
      reason: "several_people",
      flagged: ["several_faces"],
      faces: 2,
      decided_by: null,
    });
    // The owner's list says why; the queue (queued photos only) never holds it.
    const mine = await app.request("/photos", { headers: me.headers });
    expect((await mine.json()).photos).toEqual([
      expect.objectContaining({
        id: photo.id,
        state: "rejected",
        rejectionReason: "several_people",
      }),
    ]);
    const queued = await ctx.client.query(
      "SELECT count(*)::int AS n FROM photo WHERE state = 'queued'",
    );
    expect(queued.rows[0]?.n).toBe(0);
    expect(logs().find((l) => l.msg === "photo moderated")).toMatchObject({
      decision: "rejected",
      faces: 2,
      flagged: 1,
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

  test("Neither a label nor its confidence reaches the owner or a log line", async ({ ctx }) => {
    // Names and numbers nothing else in an answer or a log line would carry.
    const probe: Inspection = {
      checked: true,
      labels: [
        { name: "Probe Label Kuutti", parentName: "Probe Parent Kuutti", confidence: 77.7777 },
      ],
      tipLabels: [{ name: "Sunglasses", parentName: "Probe Face Kuutti", confidence: 66.6666 }],
      faceConfidences: [99],
      modelVersion: "7.0",
      calls: 3,
    };
    const { app, logs } = await appWith(ctx, scripted(probe));
    const me = await signedInAccount(ctx.client);
    const uploaded = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 600, height: 800, exif: false })),
    });
    expect(uploaded.status).toBe(201);
    const answers = [await uploaded.text()];
    for (const path of ["/photos", "/profile", "/account/export"]) {
      const res = await app.request(path, { headers: me.headers });
      expect(res.status).toBe(200);
      answers.push(await res.text());
    }
    // What the check saw is kept, for the moderator's queue and nobody else.
    const review = await ctx.client.query<{ labels: unknown }>("SELECT labels FROM photo_review");
    expect(JSON.stringify(review.rows)).toContain("Probe Label Kuutti");
    const seen = [...answers, JSON.stringify(logs())].join("\n");
    for (const secret of ["Probe Label", "Probe Parent", "Probe Face", "77.77", "66.66"]) {
      expect(seen).not.toContain(secret);
    }
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

/** A Rekognition client answering each of the three calls with what it is given. */
function answering(answers: {
  moderation?: Record<string, unknown>;
  faces?: Record<string, unknown>;
  scene?: Record<string, unknown>;
}): RekognitionClient {
  return {
    async send(command: unknown) {
      if (command instanceof DetectFacesCommand) return answers.faces ?? {};
      if (command instanceof DetectLabelsCommand) return answers.scene ?? {};
      return answers.moderation ?? {};
    },
  } as unknown as RekognitionClient;
}

describe("what the Rekognition adapter makes of sparse answers", () => {
  it("an answer with nothing in it is a check that saw nothing: no labels, no faces, no model version", async () => {
    const seen = await rekognitionModerator(answering({})).inspect(await fixtureWebp(80, 107));
    expect(seen).toEqual({
      checked: true,
      labels: [],
      tipLabels: [],
      faceConfidences: [],
      modelVersion: null,
      calls: 3,
    });
    // No face found, so the check rejects it, by the same rule as any other check (#253).
    expect(decideModeration(seen, { labelThreshold: 60, faceThreshold: 90 })).toEqual({
      decision: "rejected",
      flagged: [NO_FACE],
      faces: 0,
      reason: "no_person",
    });
  });

  it("drops a label without a name, reads a missing parent as none and a missing confidence as zero, and keeps fifty at most", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      Name: `Label ${i}`,
      ParentName: "Parent",
      Confidence: 55.555,
    }));
    const seen = await rekognitionModerator(
      answering({
        moderation: {
          ModerationLabels: [
            { Confidence: 99 },
            { Name: "", Confidence: 99 },
            { Name: "Suggestive" },
            ...many,
          ],
          ModerationModelVersion: "7.0",
        },
        faces: { FaceDetails: [{ Confidence: 98 }, {}] },
      }),
    ).inspect(await fixtureWebp(80, 107));
    expect(seen.labels).toHaveLength(50);
    expect(seen.labels[0]).toEqual({ name: "Suggestive", parentName: "", confidence: 0 });
    expect(seen.labels[1]).toEqual({ name: "Label 0", parentName: "Parent", confidence: 55.56 });
    expect(seen.faceConfidences).toEqual([98, 0]);
    expect(seen.modelVersion).toBe("7.0");
  });
});

describe("tip signals from sparse answers", () => {
  it("skips a scene label without a name and reads a missing parent or confidence as none", () => {
    expect(
      tipLabelsFrom([{ Confidence: 90 }, { Name: "", Confidence: 90 }, { Name: "Bathroom" }], []),
    ).toEqual([{ name: "Bathroom", parentName: "", confidence: 0 }]);
  });

  it("a face with no box, no sunglasses worn and no quality gives no face signal", () => {
    expect(
      tipLabelsFrom(
        [],
        [{ Confidence: 99, Sunglasses: { Value: false, Confidence: 99 }, Quality: {} }],
      ),
    ).toEqual([]);
  });

  it("reads the largest face, and sunglasses without a confidence as zero", () => {
    expect(
      tipLabelsFrom(
        [],
        [
          { Confidence: 99, BoundingBox: { Width: 0.2, Height: 0.2 }, Quality: { Brightness: 80 } },
          {
            Confidence: 99,
            BoundingBox: { Width: 0.5, Height: 0.4 },
            Sunglasses: { Value: true },
            Quality: { Sharpness: 0 },
          },
          { Confidence: 99, BoundingBox: { Width: 0.1 } },
        ],
      ),
    ).toEqual([
      { name: "Sunglasses", parentName: "Face", confidence: 0 },
      { name: "TightCrop", parentName: "Face", confidence: 20 },
      { name: "Sharpness", parentName: "Face", confidence: 0 },
    ]);
  });
});

describe("no automatic check (MODERATION=queue)", () => {
  test("every upload goes to a person as not checked, and nothing is approved by itself", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx, queueAllModerator());
    const me = await signedInAccount(ctx.client);
    const res = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 600, height: 800, exif: false })),
    });
    expect(res.status).toBe(201);
    const photo = await res.json();
    expect(photo.state).toBe("queued");
    const review = await ctx.client.query(
      "SELECT decision, flagged, labels, faces, model_version FROM photo_review WHERE photo_id = $1",
      [photo.id],
    );
    expect(review.rows[0]).toEqual({
      decision: "queued",
      flagged: [NOT_CHECKED],
      labels: [],
      faces: 0,
      model_version: null,
    });
    expect(logs().find((l) => l.msg === "photo moderated")).toMatchObject({
      moderator: "queue",
      decision: "queued",
      rekognitionCalls: 0,
    });
  });
});

describe("the nightly sweep's failures", () => {
  test("a pending photo whose card variant is gone, and one whose check fails again, both stay pending and are counted", async ({
    ctx,
  }) => {
    const { app, store, logs, logger } = await appWith(ctx, scripted(new Error("down")));
    const me = await signedInAccount(ctx.client);
    const ids: string[] = [];
    for (const width of [500, 501]) {
      const res = await app.request("/photos", {
        method: "POST",
        headers: me.headers,
        body: multipart(await fixtureJpeg({ width, height: 700, exif: false })),
      });
      ids.push((await res.json()).id as string);
    }
    // The first loses its card variant; the second keeps it, and the check is still down.
    const key =
      (await ctx.client.query<{ key: string }>("SELECT key FROM photo WHERE id = $1", [ids[0]]))
        .rows[0]?.key ?? "";
    await store.delete([objectKey(key, "card")]);
    const stillDown = scripted(new Error("still down"));
    const swept = await sweepPendingPhotos({
      db: ctx.client,
      logger,
      now: () => new Date(Date.now() + RECHECK_AFTER_MS + 1000),
      moderator: stillDown,
      store,
    });
    expect(swept).toEqual({ rechecked: 0, failed: 2 });
    expect(stillDown.seen).toHaveLength(1);
    expect(
      logs().find((l) => l.msg === "pending photo has no card variant to check"),
    ).toMatchObject({ photoId: ids[0] });
    const states = await ctx.client.query("SELECT state FROM photo WHERE id = ANY($1::uuid[])", [
      ids,
    ]);
    expect(states.rows).toEqual([{ state: "pending" }, { state: "pending" }]);
  });
});
