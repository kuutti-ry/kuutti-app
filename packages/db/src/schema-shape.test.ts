import {
  AccountState,
  CONSENT_KINDS,
  ConversationCloseKind,
  GENDERS,
  MessageKind,
  ModeratorRole,
  PHOTO_VARIANTS,
  PhotoPurpose,
  PhotoRejectionReason,
  PhotoState,
  ReportOutcome,
  SanctionKind,
  SanctionReason,
} from "@kuutti/schema";
import { is } from "drizzle-orm";
import { getTableConfig, isPgEnum, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema/index.ts";

// The Drizzle schema as drizzle-kit reads it (rules/db.md, TD-1, TD-7): what
// a migration is generated from. These hold the rules a generated migration
// would otherwise only show in review: uuid keys, timestamptz, no column for
// what rules 1 and 3 forbid, the foreign keys erasure relies on, the indexes
// the queries need, and enums that mirror the contracts of packages/schema.

const exported: unknown[] = Object.values(schema);
const tables = exported
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableConfig(table));
const byName = new Map(tables.map((table) => [table.name, table]));

describe("the tables", () => {
  it("are every table the migrations create but events, whose partitions a custom migration writes", () => {
    expect(tables.map((table) => table.name).sort()).toEqual([
      "account",
      "account_export",
      "admin_session",
      "audit_log",
      "auth_request",
      "block",
      "card_shown",
      "consent",
      "contact",
      "contact_share",
      "conversation",
      "conversation_participant",
      "feedback",
      "gate",
      "identity",
      "matching_config",
      "message",
      "moderator_roles",
      "photo",
      "photo_access",
      "photo_check_note",
      "photo_review",
      "ponds",
      "preferences",
      "profile",
      "report",
      "research_subject",
      "sanction",
      "session",
      "waitlist_snapshot",
    ]);
  });

  it("each have one uuid primary key", () => {
    for (const table of tables) {
      const keys = table.columns.filter((column) => column.primary);
      expect(
        keys.map((column) => column.getSQLType()),
        table.name,
      ).toEqual(["uuid"]);
      expect(table.primaryKeys, table.name).toEqual([]);
    }
  });

  it("keep every timestamp with its time zone", () => {
    const naive = tables.flatMap((table) =>
      table.columns
        .filter((column) => column.getSQLType().startsWith("timestamp"))
        .filter((column) => column.getSQLType() !== "timestamp with time zone")
        .map((column) => `${table.name}.${column.name}`),
    );
    expect(naive).toEqual([]);
  });

  it("have no column for the identity code, legal sex, a date of birth or a name from the bank (rules 1 and 3)", () => {
    const forbidden =
      /(^|_)(hetu|ssn|sex|dob|birth_?date|date_of_birth|birthday|first_?name|last_?name|given_?name|family_?name|full_?name)(_|$)/;
    const columns = tables.flatMap((table) =>
      table.columns.map((column) => `${table.name}.${column.name}`),
    );
    expect(columns.filter((name) => forbidden.test(name.split(".")[1] ?? ""))).toEqual([
      // The keyed hash of the code, never the code (rule 2).
      "identity.hetu_hmac",
    ]);
    // Age is year and month only.
    expect(columns.filter((name) => name.includes("birth"))).toEqual([
      "account.birth_year",
      "account.birth_month",
    ]);
  });
});

describe("the foreign keys", () => {
  const references = tables.flatMap((table) =>
    table.foreignKeys.map((key) => {
      const reference = key.reference();
      const target = getTableConfig(reference.foreignTable).name;
      return `${table.name}.${reference.columns.map((c) => c.name).join()} -> ${target}.${reference.foreignColumns.map((c) => c.name).join()} ${key.onDelete ?? "no action"}`;
    }),
  );

  it("cascade only from a photo to what describes it, and from a conversation to its people and messages; identity and account rows are never deleted from under anything (TD-7)", () => {
    expect(references.filter((reference) => reference.endsWith(" cascade")).sort()).toEqual([
      "card_shown.photo_id -> photo.id cascade",
      // A conversation goes only once nobody is left to keep it for (#348, ADR-031 §5),
      // and the record of its shares with it (#103).
      "contact_share.conversation_id -> conversation.id cascade",
      "conversation_participant.conversation_id -> conversation.id cascade",
      "message.conversation_id -> conversation.id cascade",
      "photo_review.photo_id -> photo.id cascade",
    ]);
  });

  it("hang every personal row on the account, and staff, sanctions and blocks on the identity", () => {
    const toAccount = references
      .filter((reference) => reference.includes(" -> account.id"))
      .map((reference) => reference.split(".")[0]);
    expect(toAccount.sort()).toEqual([
      "account_export",
      "auth_request",
      "card_shown",
      "consent",
      // The contacts the person keeps to share, deleted at erasure (#103).
      "contact",
      // The person's place in a conversation, cut to null at erasure (#348).
      "conversation_participant",
      "feedback",
      "gate",
      "photo",
      "photo_access",
      "photo_check_note",
      "preferences",
      "profile",
      "report",
      "report",
      "research_subject",
      "sanction",
      "session",
    ]);
    const toIdentity = references
      .filter((reference) => reference.includes(" -> identity.id"))
      .map((reference) => reference.split(" ")[0]);
    expect(toIdentity.sort()).toEqual([
      "account.identity_id",
      "admin_session.identity_id",
      "audit_log.actor_identity_id",
      "auth_request.identity_id",
      "block.blocked_identity_id",
      "block.blocker_identity_id",
      "feedback.handled_by",
      "moderator_roles.identity_id",
      "photo_review.decided_by",
      "report.decided_by",
      "sanction.created_by",
      "sanction.identity_id",
      "sanction.lifted_by",
      "sanction.reviewed_by",
    ]);
  });

  it("let the fetch log outlive the photo it names: photo_access.photo_id has no key", () => {
    expect(references.filter((reference) => reference.startsWith("photo_access."))).toEqual([
      "photo_access.account_id -> account.id no action",
    ]);
  });

  it("let a message outlive its photo, which reads as removed (#350)", () => {
    expect(references).toContain("message.photo_id -> photo.id set null");
  });

  it("let the photo check's note outlive its photo, without the link (#253)", () => {
    expect(
      references.filter((reference) => reference.startsWith("photo_check_note.")).sort(),
    ).toEqual([
      "photo_check_note.account_id -> account.id no action",
      "photo_check_note.photo_id -> photo.id set null",
    ]);
  });

  it("hang a sanction on the account and the identity, and every member of staff on it by identity, none of them cascading (#307)", () => {
    expect(references.filter((reference) => reference.startsWith("sanction.")).sort()).toEqual([
      "sanction.account_id -> account.id no action",
      "sanction.created_by -> identity.id no action",
      "sanction.identity_id -> identity.id no action",
      "sanction.lifted_by -> identity.id no action",
      "sanction.reviewed_by -> identity.id no action",
    ]);
  });

  it("keep a block between two identities and a report between two accounts, the decision's sanction let go by an erasure (#84, ADR-030)", () => {
    expect(references.filter((reference) => reference.startsWith("block.")).sort()).toEqual([
      "block.blocked_identity_id -> identity.id no action",
      "block.blocker_identity_id -> identity.id no action",
    ]);
    expect(references.filter((reference) => reference.startsWith("report.")).sort()).toEqual([
      "report.decided_by -> identity.id no action",
      "report.reported_account_id -> account.id no action",
      "report.reporter_account_id -> account.id no action",
      "report.sanction_id -> sanction.id set null",
    ]);
  });

  it("make the ponds a tree", () => {
    expect(references).toContain("ponds.parent_id -> ponds.id no action");
  });
});

describe("the indexes", () => {
  const index = (table: string, name: string) =>
    byName.get(table)?.indexes.find((candidate) => candidate.config.name === name)?.config;
  const columnsOf = (config: ReturnType<typeof index>) =>
    config?.columns.map((column) => ("name" in column ? column.name : "?"));

  it("allow at most one live account per identity, in the database", () => {
    const live = index("account", "account_one_live_per_identity_idx");
    expect(live?.unique).toBe(true);
    expect(live?.where).toBeDefined();
    expect(columnsOf(live)).toEqual(["identity_id"]);
  });

  it.each([
    ["matching_config", "matching_config_key_version_idx", ["key", "version"]],
    ["preferences", "preferences_account_field_idx", ["account_id", "field"]],
    ["card_shown", "card_shown_account_photo_idx", ["account_id", "photo_id"]],
    ["block", "block_pair_idx", ["blocker_identity_id", "blocked_identity_id"]],
    ["report", "report_open_pair_idx", ["reporter_account_id", "reported_account_id"]],
  ])("keep %s unique by %s", (table, name, columns) => {
    expect(index(table, name)?.unique).toBe(true);
    expect(columnsOf(index(table, name))).toEqual(columns);
  });

  it.each([
    ["photo_access", "photo_access_account_at_idx", ["account_id", "at"]],
    ["account_export", "account_export_account_at_idx", ["account_id", "at"]],
    ["feedback", "feedback_account_created_idx", ["account_id", "created_at"]],
    ["feedback", "feedback_handled_created_idx", ["handled_at", "created_at"]],
    ["card_shown", "card_shown_photo_idx", ["photo_id"]],
    ["session", "session_retired_refresh_hash_idx", ["retired_refresh_hash"]],
    ["auth_request", "auth_request_expires_at_idx", ["expires_at"]],
    ["photo_review", "photo_review_decision_idx", ["decision", "checked_at"]],
    ["photo_check_note", "photo_check_note_account_at_idx", ["account_id", "at"]],
    ["sanction", "sanction_account_created_idx", ["account_id", "created_at"]],
    ["sanction", "sanction_identity_open_idx", ["identity_id"]],
    ["report", "report_reporter_created_idx", ["reporter_account_id", "created_at"]],
    ["photo", "photo_message_day_idx", ["account_id", "created_at"]],
  ])("serve the lookups of %s with %s", (table, name, columns) => {
    expect(index(table, name)?.unique).toBe(false);
    expect(columnsOf(index(table, name))).toEqual(columns);
  });

  it("count only message photos for the day's budget (#350)", () => {
    expect(index("photo", "photo_message_day_idx")?.where).toBeDefined();
  });

  it("read only what is still open when settling a sanction (#307)", () => {
    expect(index("sanction", "sanction_identity_open_idx")?.where).toBeDefined();
    expect(index("sanction", "sanction_account_created_idx")?.where).toBeUndefined();
  });

  it("hold one open report per pair, and a block once per direction (#84)", () => {
    expect(index("report", "report_open_pair_idx")?.where).toBeDefined();
    expect(index("block", "block_pair_idx")?.where).toBeUndefined();
  });
});

describe("the checks", () => {
  it("hold a sanction's end, note, lift and review together in the database (#307, ADR-024 §1)", () => {
    expect(
      byName
        .get("sanction")
        ?.checks.map((check) => check.name)
        .sort(),
    ).toEqual([
      "sanction_ends_at_check",
      "sanction_lift_check",
      "sanction_note_check",
      "sanction_review_check",
    ]);
  });

  it("refuse a block or a report of oneself, a note out of bounds and a half-written decision (#84, ADR-030)", () => {
    const checks = (table: string) =>
      byName
        .get(table)
        ?.checks.map((check) => check.name)
        .sort();
    expect(checks("block")).toEqual(["block_not_self_check"]);
    expect(checks("report")).toEqual([
      "report_decision_check",
      "report_not_self_check",
      "report_note_check",
    ]);
  });

  it("hold a conversation's close together, its sequences from one, and a text with its body (#348, ADR-031 §2)", () => {
    const checks = (table: string) =>
      byName
        .get(table)
        ?.checks.map((check) => check.name)
        .sort();
    expect(checks("conversation")).toEqual([
      "conversation_closed_check",
      "conversation_next_seq_check",
    ]);
    expect(checks("conversation_participant")).toEqual(["conversation_participant_read_check"]);
    expect(checks("message")).toEqual([
      "message_photo_check",
      "message_seq_check",
      "message_text_body_check",
    ]);
    expect(checks("photo")).toEqual(["photo_position_check"]);
    const unique = (table: string) =>
      byName
        .get(table)
        ?.indexes.filter((index) => index.config.unique)
        .map((index) => index.config.name)
        .sort();
    expect(unique("conversation_participant")).toEqual([
      "conversation_participant_account_idx",
      "conversation_participant_side_idx",
    ]);
    expect(unique("message")).toEqual([
      "message_client_idx",
      "message_photo_idx",
      "message_seq_idx",
    ]);
  });
});

describe("the enums", () => {
  const enums = Object.fromEntries(
    exported.filter(isPgEnum).map((pgEnum) => [pgEnum.enumName, [...pgEnum.enumValues]]),
  );

  it("mirror the contracts of packages/schema", () => {
    expect(enums.gender).toEqual([...GENDERS]);
    expect(enums.account_state).toEqual(AccountState.options);
    expect(enums.consent_kind).toEqual([...CONSENT_KINDS]);
    expect(enums.moderator_role).toEqual(ModeratorRole.options);
    expect(enums.photo_state).toEqual(PhotoState.options);
    expect(enums.photo_variant).toEqual([...PHOTO_VARIANTS]);
    expect(enums.photo_purpose).toEqual(PhotoPurpose.options);
    expect(enums.photo_rejection_reason).toEqual(PhotoRejectionReason.options);
    expect(enums.sanction_kind).toEqual(SanctionKind.options);
    expect(enums.sanction_reason).toEqual(SanctionReason.options);
    expect(enums.report_outcome).toEqual(ReportOutcome.options);
    // Where a report was made: a card, until the chat of #101 adds the conversation.
    expect(enums.report_source).toEqual(["card"]);
    expect(enums.conversation_close).toEqual(ConversationCloseKind.options);
    expect(enums.conversation_side).toEqual(["a", "b"]);
    expect(enums.message_kind).toEqual(MessageKind.options);
  });

  it("are all exported, so drizzle-kit generates them", () => {
    const used = new Set(
      tables.flatMap((table) =>
        table.columns.flatMap((column) =>
          "enum" in column && isPgEnum(column.enum) ? [column.enum.enumName] : [],
        ),
      ),
    );
    expect([...used].sort()).toEqual(Object.keys(enums).sort());
  });
});
