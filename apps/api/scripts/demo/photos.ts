import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Queryable } from "@kuutti/db";
import {
  assetsFor,
  demoAssetsDir,
  negativesOf,
  type PersonaHistory,
  PHOTOS_MANIFEST,
  type PhotoAsset,
  verifyAssets,
} from "@kuutti/db/demo";
import type { Logger } from "../../src/lib/logger.ts";
import { type MediaDeps, uploadPhoto } from "../../src/media/index.ts";
import { DemoError } from "./bank.ts";

/**
 * The demo's pictures as the loaders use them (#142, ADR-014 §7): the
 * release in the cache, verified against the manifest before a byte of it is
 * read; a persona's own set and its negatives; and the look a moderator
 * gives, locally, where no check decides.
 */
export type PhotoAssets = { dir: string; manifest: readonly PhotoAsset[] };

/**
 * The release in the cache, every file present with its checksum. Null while
 * the manifest is empty (the release does not exist yet: nobody gets a
 * photo, and the command says so); a cache that is missing or not the
 * release's is refused with the files named.
 */
export function loadAssets(
  dir: string = demoAssetsDir(),
  manifest: readonly PhotoAsset[] = PHOTOS_MANIFEST,
): PhotoAssets | null {
  if (manifest.length === 0) return null;
  const problems = verifyAssets(dir, manifest);
  if (problems.length > 0) {
    const named = problems
      .slice(0, 5)
      .map((p) => `${p.path} ${p.problem}`)
      .join(", ");
    throw new DemoError(
      `the pictures in ${dir} are not the release's (${named}${problems.length > 5 ? ", …" : ""}): run pnpm demo:assets`,
    );
  }
  return { dir, manifest };
}

export type PersonaPictures = { faces: Uint8Array[]; negatives: Uint8Array[] };

/** The persona's own pictures, as many as the story counts, and its negatives: the bytes, read once each. */
export function picturesOf(
  assets: PhotoAssets,
  history: Pick<PersonaHistory, "key" | "photos" | "negatives">,
): PersonaPictures {
  const faces = assetsFor(assets.manifest, `persona:${history.key}`);
  if (faces.length < history.photos) {
    throw new DemoError(
      `the release has ${faces.length} pictures of ${history.key}, and the story needs ${history.photos}`,
    );
  }
  const negatives = negativesOf(assets.manifest);
  const wanted = history.negatives ?? [];
  const missing = wanted.filter((name) => !negatives.has(name));
  if (missing.length > 0) throw new DemoError(`the release has no negative ${missing.join(", ")}`);
  const read = (asset: PhotoAsset) => new Uint8Array(readFileSync(join(assets.dir, asset.path)));
  return {
    faces: faces.slice(0, history.photos).map(read),
    negatives: wanted.map((name) => read(negatives.get(name) as PhotoAsset)),
  };
}

/**
 * The look a moderator gives, locally: a developer's machine has the check
 * that queues everything (ADR-006, `queueAllModerator`), and a persona cannot
 * be a moderator (the reset would spare it), so the faces of a story are
 * approved by this statement, named here as the ban is (ADR-014 §12). On
 * staging the configured check decides (Rekognition, ADR-018 §8) and nothing
 * is approved by hand. The negatives are never approved: they are the queue's
 * work. Scoped to the account the pictures were uploaded for.
 */
export async function approveLocally(
  db: Queryable,
  accountId: string,
  photoIds: readonly string[],
): Promise<number> {
  if (photoIds.length === 0) return 0;
  const moved = await db.query(
    `UPDATE photo SET state = 'approved'
     WHERE account_id = $1 AND id = ANY($2) AND state IN ('pending', 'queued')`,
    [accountId, photoIds],
  );
  await db.query(
    `UPDATE photo_review SET decision = 'approved'
     WHERE decided_by IS NULL AND photo_id = ANY($2)
       AND photo_id IN (SELECT id FROM photo WHERE account_id = $1)`,
    [accountId, photoIds],
  );
  return moved.rowCount ?? 0;
}

export type FaceUploadDeps = MediaDeps & { db: Queryable; logger: Logger; now: () => Date };

/**
 * The population's faces through the pipeline (rule 4): each person's
 * pictures, drawn beforehand by seed, uploaded as anybody's are, and where
 * no check decides, approved as a moderator would. The same face for two
 * people is the same content address; the store keeps one copy.
 */
export async function uploadFaces(
  deps: FaceUploadDeps,
  assets: PhotoAssets,
  faces: ReadonlyMap<string, readonly PhotoAsset[]>,
  options: { approve: boolean },
): Promise<{ people: number; photos: number; approved: number }> {
  const bytes = new Map<string, Uint8Array>();
  const read = (asset: PhotoAsset): Uint8Array => {
    let cached = bytes.get(asset.path);
    if (!cached) {
      cached = new Uint8Array(readFileSync(join(assets.dir, asset.path)));
      bytes.set(asset.path, cached);
    }
    return cached;
  };
  let people = 0;
  let photos = 0;
  let approved = 0;
  for (const [accountId, own] of faces) {
    if (own.length === 0) continue;
    people += 1;
    const ids: string[] = [];
    for (const asset of own) {
      ids.push((await uploadPhoto(deps, { accountId, bytes: read(asset) })).id);
    }
    photos += ids.length;
    if (options.approve) approved += await approveLocally(deps.db, accountId, ids);
  }
  return { people, photos, approved };
}
