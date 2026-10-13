import type { TFunction } from "@kuutti/i18n";
import type { AccountExport } from "@kuutti/schema";
import { strToU8, zipSync } from "fflate";
import { AppError } from "../lib/errors.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { dayWindow, type ExportedPhotoFile, secondsUntil } from "../media/index.ts";
import { type ExportDeps, exportAccount } from "./erasure.ts";
import * as repo from "./repo.ts";

// The copy a person downloads (#237, ADR-007 §3): one zip, built here, with
// the document as JSON and every photo's full-size file beside it, so the
// copy is a copy and not a list of links that die in fifteen minutes. At
// most matching_config exports_per_day per Finnish calendar day: the zip
// carries every photo, and the day's copies bound what one session can pull.

export const EXPORTS_PER_DAY_KEY = "exports_per_day";

export type ExportArchive = {
  /** `<stem>-<date>.zip`, the stem in the request's language; nothing about the person in it. */
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
};

/**
 * The export's file stem and date, in the request's language, ASCII only: the
 * name goes into a header and the phone's Files app (the i18n test holds the
 * stems to `[a-z0-9-]`).
 */
export function exportFileStem(t: TFunction, exportedAt: Date): string {
  return `${t("account.export.fileName")}-${finnishDay(exportedAt)}`;
}

/**
 * Records the request under the day's cap, then builds the zip. The record
 * comes first so the document lists this copy with the earlier ones; over
 * the cap nothing is written and the answer is 429 with the wait until the
 * day rolls, said plainly (nobody is limited in silence).
 */
export async function exportArchive(
  deps: ExportDeps,
  accountId: string,
  t: TFunction,
): Promise<ExportArchive> {
  const at = deps.now();
  const day = dayWindow(at);
  const limit = await matchingConfigNumber(deps.db, EXPORTS_PER_DAY_KEY);
  const record = await repo.recordExport(deps.db, { accountId, at, since: day.start, limit });
  // No live account, no export: the account was erased between the guard and here (#51).
  if (!record.live) throw new AppError(404, "not_found", "No such account");
  if (!record.recorded) {
    const retryAfterSeconds = secondsUntil(day.end, at);
    deps.logger.warn(
      { accountId, used: record.used, limit, retryAfterSeconds, reason: "budget" },
      "export refused",
    );
    throw new AppError(429, "export_budget_exceeded", "The day's copies are used up", {
      retryAfterSeconds,
    });
  }
  let document: AccountExport;
  let files: ExportedPhotoFile[];
  try {
    ({ document, files } = await exportAccount(deps, accountId, t));
  } catch (error) {
    // A store or database failure is not a copy taken: the row goes back,
    // so three bad minutes do not lock the person out until midnight.
    if (record.id) await repo.deleteExport(deps.db, accountId, record.id);
    throw error;
  }
  const stem = exportFileStem(t, at);
  // Every entry dated at the export; the photos are WebP already and are
  // stored as they are, the JSON deflates.
  const bytes = zipSync(
    {
      [`${stem}.json`]: [strToU8(JSON.stringify(document, null, 2)), { level: 6 }],
      ...Object.fromEntries(files.map((file) => [file.path, [file.bytes, { level: 0 }]])),
    },
    { mtime: at },
  );
  deps.logger.info({ accountId, photos: files.length, bytes: bytes.byteLength }, "export built");
  // fflate allocates the archive itself, so the buffer is a plain ArrayBuffer; the type says less.
  return { name: `${stem}.zip`, bytes: bytes as Uint8Array<ArrayBuffer> };
}
