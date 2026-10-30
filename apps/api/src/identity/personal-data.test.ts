import { readFileSync } from "node:fs";
import { AccountExport } from "@kuutti/schema";
import { describe, expect, it } from "vitest";
import { test } from "../test/harness.ts";

// The register of where a person's data goes (#525, TD-7, ADR-007): every table
// the database holds, what erasure does to it and where the export carries it.
// The per-slice tests of erasure.test.ts show that each eraser works; this one
// shows nothing was forgotten, by holding the register to the catalogue of the
// real database, to the calls in eraseAccount and to the export's contract. So
// a new table cannot land undecided, nor a new column on a row that outlives
// the person, the one place a forgotten column stays behind in silence. The
// personal-data skill is the walk that fills this in.

type Section = keyof typeof AccountExport.shape;

/** The sections that carry it, or why the export leaves it out. */
type Exported = readonly Section[] | { not: string };

type Entry =
  // Every row goes in the erasure, `by` this call of eraseAccount.
  | { erasure: "goes"; by: string; exported: Exported }
  // Rows outlive the person, for `why`. `stays` is every column that does, by name, so
  // that a new one fails here until somebody decides; `by` is the call that touches them.
  | {
      erasure: "stays";
      why: string;
      stays: string;
      cleared?: string;
      by?: string;
      exported: Exported;
    }
  // It holds nobody's data, and no foreign key may say otherwise.
  | { erasure: "nobody"; why: string };

const SPENT_IN_MINUTES = "A sign-in under way, swept when it expires.";

const REGISTER: Record<string, Entry> = {
  account: {
    erasure: "stays",
    why: "The tombstone: the partial unique index then admits a new live account after the cooldown.",
    by: "tombstoneAccount",
    // paused_from is the bug of #527: it should be cleared, and moves there with that fix.
    stays: "id identity_id state state_changed_at paused_from registered_at deleted_at",
    cleared:
      "birth_month birth_year email email_confirmed_at found_them_answered gender gender_changed_at pond_id sanctioned_from seeks_changed_at",
    exported: ["account"],
  },
  account_export: { erasure: "goes", by: "deleteExportsOfAccount", exported: ["exports"] },
  admin_session: {
    erasure: "stays",
    why: "A member of staff's own session, on the identity; swept when it ends.",
    stays: "access_hash created_at expires_at id identity_id last_used_at revoked_at role",
    exported: { not: "A member of staff's work, not the person's account." },
  },
  audit_log: {
    erasure: "stays",
    why: "Append-only record of what staff did (migration 0006); it outlives everybody.",
    stays: "action actor_identity_id at detail id subject_id subject_type",
    exported: { not: "No route exports it (docs/security-checklist.md)." },
  },
  auth_request: {
    erasure: "goes",
    by: "deleteAuthRequestsOfAccount",
    exported: { not: SPENT_IN_MINUTES },
  },
  block: {
    erasure: "stays",
    why: "On the two identities, so neither later account meets the other (ADR-030 §8).",
    stays: "blocked_identity_id blocker_identity_id created_at id",
    exported: ["blocks"],
  },
  card_shown: { erasure: "goes", by: "erasePhotosOfAccount", exported: ["cardsShown"] },
  consent: { erasure: "goes", by: "deleteConsentsOfAccount", exported: ["consents"] },
  contact: { erasure: "goes", by: "eraseConversationsOf", exported: ["contacts"] },
  contact_share: {
    erasure: "stays",
    why: "Ended by the close, the record of a share with no value in it (ADR-031 §11).",
    by: "eraseConversationsOf",
    stays: "conversation_id ended_at ended_how id kind shared_at side",
    exported: ["conversations"],
  },
  conversation: {
    erasure: "stays",
    why: "Closed, kept for the counterpart; goes once both people are erased (ADR-031 §5).",
    by: "eraseConversationsOf",
    stays: "archived_at closed_at closed_by closed_how id last_message_at next_seq opened_at",
    exported: ["conversations"],
  },
  conversation_participant: {
    erasure: "stays",
    why: "account_id goes null: the counterpart reads a deleted user (#348).",
    by: "eraseConversationsOf",
    stays: "account_id conversation_id id joined_at read_up_to side",
    exported: ["conversations"],
  },
  email_code: {
    erasure: "goes",
    by: "deleteEmailRows",
    exported: { not: "A code waiting to be typed, kept as its hash." },
  },
  email_send: {
    erasure: "goes",
    by: "deleteEmailRows",
    exported: { not: "The day's sends, counted against the limit and pruned." },
  },
  events: {
    erasure: "stays",
    why: "Keyed by research_id: the mapping row goes, and they cannot be joined back (rule 5, TD-5).",
    stays: "age_band at consent_version id name pond props research_id snapshot",
    exported: ["research"],
  },
  feedback: { erasure: "goes", by: "deleteFeedbackOfAccount", exported: ["feedback"] },
  found_them_count: { erasure: "nobody", why: "A count by day and reason (#83, ADR-040)." },
  gate: { erasure: "goes", by: "deleteGateOfAccount", exported: ["gate"] },
  identity: {
    erasure: "stays",
    why: "Standing, the deletion count and the cooldown outlive the account (TD-7).",
    by: "recordIdentityDeletion",
    stays:
      "acr amr authenticated_at broker_session_index broker_subject broker_token_id created_at deletion_count hetu_hmac id refused_attempts reregister_after standing standing_changed_at suspension_ends_at",
    exported: ["identity"],
  },
  invitation: {
    erasure: "stays",
    why: "A redeemed one stays for its redeemer, the link to the person cut (ADR-044 §10).",
    by: "eraseInvitationsOf",
    stays:
      "code_hash counted_at created_at id inviter_account_id redeemed_at redeemed_by_account_id",
    exported: ["invitations"],
  },
  matching_config: { erasure: "nobody", why: "Parameters, written by staff and migrations." },
  message: {
    erasure: "stays",
    why: "The counterpart's copy of the conversation; what they never received goes (ADR-031 §5).",
    by: "eraseConversationsOf",
    stays: "body client_id conversation_id created_at id kind photo_id seq side",
    exported: ["conversations"],
  },
  moderator_roles: {
    erasure: "stays",
    why: "A member of staff's role, on the identity.",
    stays: "granted_at granted_by identity_id role",
    exported: { not: "A member of staff's work, not the person's account." },
  },
  notice: { erasure: "goes", by: "eraseNotificationsOf", exported: ["notifications"] },
  notification_preference: {
    erasure: "goes",
    by: "eraseNotificationsOf",
    exported: ["notifications"],
  },
  photo: {
    erasure: "stays",
    why: "Only a photo a report's frozen copy holds, for its twelve months (#351, ADR-030 §12).",
    by: "erasePhotosOfAccount",
    stays:
      "account_id appealable blurhash caption created_at height id key position purpose rejection_reason state width",
    exported: ["conversations", "photos"],
  },
  photo_access: { erasure: "goes", by: "erasePhotosOfAccount", exported: ["photoAccessLog"] },
  photo_check_note: {
    erasure: "goes",
    by: "deletePhotoCheckNotesOfAccount",
    exported: ["photoCheck"],
  },
  photo_review: {
    erasure: "stays",
    why: "With its photo: gone with it, or held with it for a report's copy (#351).",
    by: "erasePhotosOfAccount",
    stays:
      "appealed_at checked_at decided_at decided_by decision description faces flagged labels model_version photo_id reason",
    exported: ["photos"],
  },
  ponds: { erasure: "nobody", why: "The areas." },
  preferences: {
    erasure: "goes",
    by: "deletePreferencesOfAccount",
    exported: ["dealBreakers", "preferences"],
  },
  profile: { erasure: "goes", by: "eraseProfileOfAccount", exported: ["profile"] },
  push_token: { erasure: "goes", by: "erasePushTokensOf", exported: ["sessions"] },
  report: {
    erasure: "stays",
    why: "Twelve months from filing, whoever of the two is erased (ADR-030 §8).",
    stays:
      "conversation_id created_at decided_at decided_by id line_seq note outcome photo_id photo_pointed reason reported_account_id reporter_account_id sanction_id source",
    exported: ["reports"],
  },
  report_message: {
    erasure: "stays",
    why: "The report's frozen copy, for the report's twelve months (#351, ADR-030 §12).",
    stays: "body created_at id kind photo_id report_id seq side",
    exported: { not: "In nobody's export, the reporter's included (ADR-030 §12)." },
  },
  research_subject: { erasure: "goes", by: "removeResearchSubject", exported: ["research"] },
  reward: { erasure: "goes", by: "eraseInvitationsOf", exported: ["invitations"] },
  round_entries: { erasure: "goes", by: "eraseRoundsOf", exported: ["rounds"] },
  round_relaxation: { erasure: "goes", by: "eraseRoundsOf", exported: ["rounds"] },
  rounds: { erasure: "goes", by: "eraseRoundsOf", exported: ["rounds"] },
  sanction: {
    erasure: "stays",
    why: "Only the open bans and suspensions, which carry the identity's standing (ADR-024 §8).",
    by: "deleteSanctionsOfAccount",
    stays:
      "account_id created_at created_by ends_at id identity_id kind lifted_at lifted_by note reason review_note reviewed_at reviewed_by rule rule_count rule_first_at",
    exported: ["sanctions"],
  },
  session: { erasure: "goes", by: "deleteAccountSessions", exported: ["sessions"] },
  waitlist_snapshot: { erasure: "nobody", why: "A pond's counts by day (ADR-013)." },
};

/** The calls of eraseAccount that erase nothing themselves. */
const NOT_ERASERS = [
  "transaction",
  "lockAccountRow",
  "findIdentitySummaryForAccount",
  "photosHeldByReports",
  // The files of the rows erasePhotosOfAccount took.
  "deleteOrphanedObjects",
];

/** The document's own lines, which no table feeds. */
const ABOUT_THE_DOCUMENT = ["exportedAt", "exportedBy"];

const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  return text.slice(from, text.indexOf(end, from));
}

const eraseAccountCalls = [
  ...between(
    source("./erasure.ts"),
    "export async function eraseAccount",
    "async function exportPhotoCheck",
  ).matchAll(/await (?:repo\.)?(\w+)\(/g),
].map((match) => match[1] ?? "");

const entries = Object.entries(REGISTER);

describe("the register of a person's data", () => {
  test("names every table of the database, and only those", async ({ ctx }) => {
    const { rows } = await ctx.client.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        ORDER BY 1`,
    );
    expect(Object.keys(REGISTER).sort()).toEqual(rows.map((row) => row.name).sort());
  });

  test("holds every column of a row that outlives the person", async ({ ctx }) => {
    const { rows } = await ctx.client.query<{ name: string; columns: string[] }>(
      `SELECT c.relname AS name, array_agg(a.attname::text ORDER BY a.attname) AS columns
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        GROUP BY 1`,
    );
    const columns = new Map(rows.map((row) => [row.name, row.columns]));
    for (const [table, entry] of entries) {
      if (entry.erasure !== "stays") continue;
      const named = `${entry.stays} ${entry.cleared ?? ""}`.trim().split(" ");
      expect(named.sort(), table).toEqual(columns.get(table));
    }
  });

  test("calls nobody a table that points at an account or an identity", async ({ ctx }) => {
    const { rows } = await ctx.client.query<{ name: string }>(
      `SELECT DISTINCT conrelid::regclass::text AS name FROM pg_constraint
        WHERE contype = 'f' AND confrelid::regclass::text IN ('account', 'identity')`,
    );
    const pointing = rows.map((row) => row.name);
    expect(pointing.length).toBeGreaterThan(0);
    expect(pointing.filter((table) => REGISTER[table]?.erasure === "nobody")).toEqual([]);
  });

  it("names only calls eraseAccount makes", () => {
    const named = entries.flatMap(([, entry]) =>
      entry.erasure !== "nobody" && entry.by ? [entry.by] : [],
    );
    expect(named.filter((by) => !eraseAccountCalls.includes(by))).toEqual([]);
  });

  it("accounts for every call eraseAccount makes", () => {
    const named = new Set(
      entries.flatMap(([, entry]) => (entry.erasure !== "nobody" && entry.by ? [entry.by] : [])),
    );
    expect(eraseAccountCalls.length).toBeGreaterThan(0);
    expect(
      eraseAccountCalls.filter((call) => !named.has(call) && !NOT_ERASERS.includes(call)),
    ).toEqual([]);
  });

  it("names columns the tombstone really clears", () => {
    const tombstone = between(
      source("./repo.ts"),
      "export async function tombstoneAccount",
      "WHERE id = $1",
    );
    const entry = REGISTER.account;
    if (entry?.erasure !== "stays") throw new Error("the account row stays");
    const cleared = entry.cleared?.split(" ") ?? [];
    expect(cleared.length).toBeGreaterThan(0);
    expect(cleared.filter((column) => !tombstone.includes(`${column} = `))).toEqual([]);
  });

  it("names only sections of the export, and every section", () => {
    const sections = Object.keys(AccountExport.shape);
    const named = new Set(
      entries.flatMap(([, entry]) =>
        entry.erasure !== "nobody" && Array.isArray(entry.exported) ? entry.exported : [],
      ),
    );
    expect([...named].filter((section) => !sections.includes(section))).toEqual([]);
    expect(
      sections.filter((key) => !named.has(key as Section) && !ABOUT_THE_DOCUMENT.includes(key)),
    ).toEqual([]);
  });
});
