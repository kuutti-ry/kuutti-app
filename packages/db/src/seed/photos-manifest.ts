import type { PhotoAsset } from "./photos.ts";

// Written by `pnpm demo:assets -- --manifest <dir>` from the pictures of
// release v1 of kuutti-ry/kuutti-app-demo-photos (#142, ADR-014 §7): every
// file's path, SHA-256 and purpose. The pictures themselves are never in this
// repository; a test refuses a binary under packages/db/src/seed. Empty until
// the release exists: with no entry, no persona and nobody of the population
// gets a photo, and the commands say so.
export const PHOTOS_MANIFEST: readonly PhotoAsset[] = [];
