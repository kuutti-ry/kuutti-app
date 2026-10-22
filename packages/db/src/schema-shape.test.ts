import {
  AccountState,
  CONSENT_KINDS,
  ConversationCloseKind,
  FoundReason,
  GENDERS,
  MessageKind,
  ModeratorRole,
  NoticeKind,
  NotificationKind,
  PHOTO_VARIANTS,
  PhotoPurpose,
  PhotoRejectionReason,
  PhotoState,
  RelaxationKind,
  ReportMessageSide,
  ReportOutcome,
  ReportSource,
  RewardKind,
  RoundDecision,
  RoundReason,
  SanctionKind,
  SanctionReason,
  SanctionRule,
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
      // The code waiting for the optional e-mail and the day's sends (#385, ADR-043).
      "email_code",
      "email_send",
      "feedback",
      // "Löysin hänet": a count by day and reason, naming nobody (#83, ADR-040).
      "found_them_count",
      "gate",
      "identity",
      // An invitation, and the units it earned its inviter (#107, ADR-044).
      "invitation",
      "matching_config",
      "message",
      "moderator_roles",
      "notice",
      "notification_preference",
      "photo",
      "photo_access",
      "photo_check_note",
      "photo_review",
      "ponds",
      "preferences",
      "profile",
      "report",
      "report_message",
      "research_subject",
      "reward",
      // Today's round and its entries (#96, ADR-034), and a day's relaxations (#99, ADR-042).
      "round_entries",
      "round_relaxation",
      "rounds",
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

  it("cascade only from a photo to what describes it, from a conversation to its people and messages, from a report to its copy, from a sanction or an invitation to its notice, and from an invitation to what it earned; identity and account rows are never deleted from under anything (TD-7)", () => {
    expect(references.filter((reference) => reference.endsWith(" cascade")).sort()).toEqual([
      "card_shown.photo_id -> photo.id cascade",
      // A conversation goes only once nobody is left to keep it for (#348, ADR-031 §5),
      // and the record of its shares with it (#103).
      "contact_share.conversation_id -> conversation.id cascade",
      "conversation_participant.conversation_id -> conversation.id cascade",
      "message.conversation_id -> conversation.id cascade",
      // A counted invitation's notice goes with its invitation (#107).
      "notice.invitation_id -> invitation.id cascade",
      // A warning's notice goes with its warning (#176).
      "notice.sanction_id -> sanction.id cascade",
      "photo_review.photo_id -> photo.id cascade",
      // A report's frozen copy goes with the report, twelve months from filing (#351).
      "report_message.report_id -> report.id cascade",
      // The units an invitation earned go with it (#107, ADR-044).
      "reward.invitation_id -> invitation.id cascade",
      // A round's entries go with their round (#96), and its relaxations (#99).
      "round_entries.round_id -> rounds.id cascade",
      "round_relaxation.round_id -> rounds.id cascade",
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
      // The e-mail's waiting code and the day's sends, deleted at erasure (#385).
      "email_code",
      "email_send",
      "feedback",
      "gate",
      // The inviter and the redeemer of an invitation (#107): at either's
      // erasure the row goes, or that side's link is cut to null.
      "invitation",
      "invitation",
      // A notice and the notification choices (#176), erased with the account.
      "notice",
      "notification_preference",
      "photo",
      "photo_access",
      "photo_check_note",
      "preferences",
      "profile",
      "report",
      "report",
      "research_subject",
      // The units the person earned (#107), deleted at erasure.
      "reward",
      // The entries in which the person is somebody's card, and the person's own rounds (#96).
      "round_entries",
      "rounds",
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
      "report.conversation_id -> conversation.id set null",
      "report.decided_by -> identity.id no action",
      "report.reported_account_id -> account.id no action",
      "report.reporter_account_id -> account.id no action",
      "report.sanction_id -> sanction.id set null",
    ]);
    // The frozen copy goes with its report, and holds its photos (#351, ADR-030 §12).
    expect(
      references.filter((reference) => reference.startsWith("report_message.")).sort(),
    ).toEqual([
      "report_message.photo_id -> photo.id no action",
      "report_message.report_id -> report.id cascade",
    ]);
  });

  it("let an invitation outlive its inviter once redeemed and its redeemer once counted, and a spent unit its round entry, without the link (#107, ADR-044)", () => {
    expect(references.filter((reference) => reference.startsWith("invitation.")).sort()).toEqual([
      "invitation.inviter_account_id -> account.id no action",
      "invitation.redeemed_by_account_id -> account.id no action",
    ]);
    // Both people's links may be cut to null by an erasure (ADR-044 §10).
    expect(
      byName
        .get("invitation")
        ?.columns.filter((column) => !column.notNull)
        .map((column) => column.name)
        .sort(),
    ).toEqual(["counted_at", "inviter_account_id", "redeemed_at", "redeemed_by_account_id"]);
    expect(references.filter((reference) => reference.startsWith("reward.")).sort()).toEqual([
      "reward.account_id -> account.id no action",
      "reward.invitation_id -> invitation.id cascade",
      "reward.spent_entry_id -> round_entries.id set null",
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
    ["report_message", "report_message_seq_idx", ["report_id", "seq"]],
    ["notification_preference", "notification_preference_kind_idx", ["account_id", "kind"]],
    ["found_them_count", "found_them_count_day_reason_idx", ["day", "reason"]],
    ["round_relaxation", "round_relaxation_round_field_idx", ["round_id", "field"]],
    // One invitation per code, and one redeemed per person (#107).
    ["invitation", "invitation_code_hash_idx", ["code_hash"]],
    ["invitation", "invitation_redeemed_by_idx", ["redeemed_by_account_id"]],
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
    ["report_message", "report_message_photo_idx", ["photo_id"]],
    ["notice", "notice_account_created_idx", ["account_id", "created_at"]],
    ["invitation", "invitation_inviter_created_idx", ["inviter_account_id", "created_at"]],
    ["reward", "reward_account_kind_idx", ["account_id", "kind"]],
    ["reward", "reward_invitation_idx", ["invitation_id"]],
    ["reward", "reward_spent_entry_idx", ["spent_entry_id"]],
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

  it("read only spent units for what an entry was paid with (#107)", () => {
    expect(index("reward", "reward_spent_entry_idx")?.where).toBeDefined();
    expect(index("reward", "reward_account_kind_idx")?.where).toBeUndefined();
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
      // An automatic rule's record, whole and only on a shadow ban by nobody (#105).
      "sanction_rule_check",
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
      "report_conversation_check",
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

describe("the checks of invitations and their notices (#107, ADR-044)", () => {
  const checks = (table: string) =>
    byName
      .get(table)
      ?.checks.map((check) => check.name)
      .sort();

  it("hold an invitation open, redeemed or counted, never by its own inviter and always somebody's, and a spent unit to when it was spent", () => {
    expect(checks("invitation")).toEqual([
      "invitation_named_check",
      "invitation_not_self_check",
      "invitation_redeemed_check",
    ]);
    expect(checks("reward")).toEqual(["reward_spent_check"]);
  });

  it("hold a warning to its sanction and a counted invitation's notice to its invitation", () => {
    expect(checks("notice")).toEqual(["notice_invitation_check", "notice_warning_check"]);
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
    // The automatic rule that applied a shadow ban (#105).
    expect(enums.sanction_rule).toEqual(SanctionRule.options);
    // Why a card is in a round, and what was decided about it (#96).
    expect(enums.round_reason).toEqual(RoundReason.options);
    expect(enums.round_decision).toEqual(RoundDecision.options);
    // How a deal-breaker is relaxed for the day (#99).
    expect(enums.relaxation_kind).toEqual(RelaxationKind.options);
    expect(enums.report_outcome).toEqual(ReportOutcome.options);
    // Where a report was made: a card, or a conversation (#351).
    expect(enums.report_source).toEqual(ReportSource.options);
    // Whose line a report's copy holds, seen from the report (#351).
    expect(enums.report_message_side).toEqual(ReportMessageSide.options);
    // What a person may be notified of, and what a notice is about (#176).
    expect(enums.notification_kind).toEqual(NotificationKind.options);
    expect(enums.notice_kind).toEqual(NoticeKind.options);
    // What one unit of the reward ledger is (#107).
    expect(enums.reward_kind).toEqual(RewardKind.options);
    expect(enums.conversation_close).toEqual(ConversationCloseKind.options);
    expect(enums.conversation_side).toEqual(["a", "b"]);
    expect(enums.message_kind).toEqual(MessageKind.options);
    // Why a person told Kuutti they found someone (#83).
    expect(enums.found_reason).toEqual(FoundReason.options);
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
