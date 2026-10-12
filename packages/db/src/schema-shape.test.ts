import {
  AccountState,
  CONSENT_KINDS,
  GENDERS,
  ModeratorRole,
  PHOTO_VARIANTS,
  PhotoRejectionReason,
  PhotoState,
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
      "admin_session",
      "audit_log",
      "auth_request",
      "card_shown",
      "consent",
      "gate",
      "identity",
      "matching_config",
      "moderator_roles",
      "photo",
      "photo_access",
      "photo_check_note",
      "photo_review",
      "ponds",
      "preferences",
      "profile",
      "research_subject",
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

  it("cascade only from a photo to what describes it; identity and account rows are never deleted from under anything (TD-7)", () => {
    expect(references.filter((reference) => reference.endsWith(" cascade")).sort()).toEqual([
      "card_shown.photo_id -> photo.id cascade",
      "photo_review.photo_id -> photo.id cascade",
    ]);
  });

  it("hang every personal row on the account, and staff and sanctions on the identity", () => {
    const toAccount = references
      .filter((reference) => reference.includes(" -> account.id"))
      .map((reference) => reference.split(".")[0]);
    expect(toAccount.sort()).toEqual([
      "auth_request",
      "card_shown",
      "consent",
      "gate",
      "photo",
      "photo_access",
      "photo_check_note",
      "preferences",
      "profile",
      "research_subject",
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
      "moderator_roles.identity_id",
      "photo_review.decided_by",
    ]);
  });

  it("let the fetch log outlive the photo it names: photo_access.photo_id has no key", () => {
    expect(references.filter((reference) => reference.startsWith("photo_access."))).toEqual([
      "photo_access.account_id -> account.id no action",
    ]);
  });

  it("let the photo check's note outlive its photo, without the link (#253)", () => {
    expect(
      references.filter((reference) => reference.startsWith("photo_check_note.")).sort(),
    ).toEqual([
      "photo_check_note.account_id -> account.id no action",
      "photo_check_note.photo_id -> photo.id set null",
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
  ])("keep %s unique by %s", (table, name, columns) => {
    expect(index(table, name)?.unique).toBe(true);
    expect(columnsOf(index(table, name))).toEqual(columns);
  });

  it.each([
    ["photo_access", "photo_access_account_at_idx", ["account_id", "at"]],
    ["card_shown", "card_shown_photo_idx", ["photo_id"]],
    ["session", "session_retired_refresh_hash_idx", ["retired_refresh_hash"]],
    ["auth_request", "auth_request_expires_at_idx", ["expires_at"]],
    ["photo_review", "photo_review_decision_idx", ["decision", "checked_at"]],
    ["photo_check_note", "photo_check_note_account_at_idx", ["account_id", "at"]],
  ])("serve the lookups of %s with %s", (table, name, columns) => {
    expect(index(table, name)?.unique).toBe(false);
    expect(columnsOf(index(table, name))).toEqual(columns);
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
    expect(enums.photo_rejection_reason).toEqual(PhotoRejectionReason.options);
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
