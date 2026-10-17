import type { Queryable } from "@kuutti/db";
import { daysBand, messageCountBand } from "@kuutti/schema";
import type { NightlyJob } from "../jobs/nightly.ts";
import type { Logger } from "../lib/logger.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { track } from "../research/index.ts";
import * as repo from "./repo.ts";

// The night's archive (#348, TD-13, #100's "nightly job archives silent
// matches"): a conversation nobody wrote in for matching_config
// silent_match_archive_days is put away, and the next message brings it back
// (the send clears archived_at). A closed one stays as it is. A break stops
// no clock (ADR-022 §4): the paused person's conversations go the same way.

const SILENT_MATCH_ARCHIVE_DAYS_KEY = "silent_match_archive_days";

const DAY_MS = 86_400_000;

export type ArchiveDeps = { db: Queryable; logger: Logger; now: () => Date };

/** Archives what fell silent; each archive is a research event for each linked person. The count archived. */
export async function archiveSilentConversations(deps: ArchiveDeps): Promise<number> {
  const days = await matchingConfigNumber(deps.db, SILENT_MATCH_ARCHIVE_DAYS_KEY);
  const at = deps.now();
  const archived = await repo.archiveSilent(deps.db, {
    at,
    olderThan: new Date(at.getTime() - days * DAY_MS),
  });
  for (const conversation of archived) {
    for (const accountId of conversation.accountIds) {
      await track(deps, accountId, "conversation_archived", {
        messages: messageCountBand(conversation.messages),
        days: daysBand(Math.floor((at.getTime() - conversation.openedAt.getTime()) / DAY_MS)),
      });
    }
  }
  return archived.length;
}

export function archiveJob(deps: ArchiveDeps): NightlyJob {
  return {
    name: "archive-silent-conversations",
    run: async () => ({ archived: await archiveSilentConversations(deps) }),
  };
}
