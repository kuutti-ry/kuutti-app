import type { PlainMessageKey } from "@kuutti/i18n";
import type { ModeratorRejectionReason } from "@kuutti/schema";

/**
 * The reasons a person rejects a photo for, in the panel's words, in the
 * order the select lists them: the queue's (#49), and a take-down's on a
 * person's page (#477). The owner is told the reason in their own language.
 */
export const REJECTION_REASONS: ReadonlyArray<{
  value: ModeratorRejectionReason;
  label: PlainMessageKey;
}> = [
  { value: "nudity", label: "admin.queue.reason.nudity" },
  { value: "no_person", label: "admin.queue.reason.no_person" },
  { value: "several_people", label: "admin.queue.reason.several_people" },
  { value: "minor", label: "admin.queue.reason.minor" },
  { value: "violence", label: "admin.queue.reason.violence" },
  { value: "contact_details", label: "admin.queue.reason.contact_details" },
  { value: "other", label: "admin.queue.reason.other" },
];
