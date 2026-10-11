import type { Queryable } from "@kuutti/db";
import { escapeIdentifier } from "pg";

/** `kuutti_pr_<n>` on the staging instance, one per open pull request (#9, TD-19). */
const PREVIEW_DATABASE_PATTERN = /^kuutti_pr_[0-9]{1,7}$/;

/**
 * Creates the pull request's database when it does not exist yet. CREATE
 * DATABASE cannot run inside a transaction, so the check and the create are
 * two statements; a second container starting at the same moment (a redeploy
 * overlapping the old one) gets "already exists", which is the same outcome.
 * The database is never a copy of anything: the caller migrates and seeds it.
 */
export async function ensurePreviewDatabase(
  admin: Queryable,
  name: string,
): Promise<"created" | "exists"> {
  if (!PREVIEW_DATABASE_PATTERN.test(name)) {
    throw new Error(`not a preview database name: ${name}`);
  }
  const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (existing.rowCount) return "exists";
  try {
    // A name that matched the pattern above; quoted anyway so the shape is a rule, not a hope.
    await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
    return "created";
  } catch (error) {
    if ((error as { code?: string }).code === "42P04") return "exists"; // duplicate_database
    throw error;
  }
}
