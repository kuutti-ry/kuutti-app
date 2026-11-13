/**
 * Grants, changes or removes a staff role (#49, rules/admin.md): the allowlist
 * is a moderator_roles row on an identity, found by its hetu_hmac. The API
 * never logs that value; `recent` lists the identities that logged in last,
 * in the app or on the panel, which records a known identity's login even
 * while it refuses it for want of a role (#202), so the person signs in once
 * and the maintainer grants the role to the row at the top. Run by the
 * maintainer against a database they can reach:
 *
 *   pnpm --filter @kuutti/db moderator -- recent
 *   pnpm --filter @kuutti/db moderator -- grant <hetu_hmac> moderator --by "<your name>"
 *   pnpm --filter @kuutti/db moderator -- revoke <hetu_hmac>
 *   pnpm --filter @kuutti/db moderator -- list
 *
 * Refuses production unless --env production is given on purpose.
 */
import { createPool, transaction } from "../pool.ts";
import { argumentsOf } from "./arguments.ts";

const ROLES = new Set(["moderator", "admin", "researcher"]);
/** As long as the staff list may show the name of who granted a role (StaffMember.grantedBy). */
const GRANTOR_MAX = 200;

async function main(): Promise<number> {
  let parsed: ReturnType<typeof argumentsOf>;
  try {
    parsed = argumentsOf(process.argv.slice(2), ["--env", "--by"]);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  const [command, hetuHmac, role] = parsed.positionals;
  const arg = (name: string) => parsed.options[name];
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    return 2;
  }
  const env = arg("--env") ?? process.env.APP_ENV ?? "development";
  if (
    (env === "production" || process.env.APP_ENV === "production") &&
    arg("--env") !== "production"
  ) {
    console.error("refusing production without --env production");
    return 2;
  }
  if (!["recent", "list", "grant", "revoke"].includes(command ?? "")) {
    console.error(
      "usage: moderator grant <hetu_hmac> <role> --by <name> | revoke <hetu_hmac> | list",
    );
    return 2;
  }
  const length = command === "grant" ? 3 : command === "revoke" ? 2 : 1;
  if (parsed.positionals.length > length) {
    console.error(`unexpected argument ${parsed.positionals[length]}`);
    return 2;
  }
  const pool = createPool({
    connectionString: url,
    max: 1,
    applicationName: "kuutti-moderator-cli",
  });
  try {
    if (command === "recent") {
      const { rows } = await pool.query<{
        hetu_hmac: string;
        authenticated_at: Date | null;
        standing: string;
      }>(
        "SELECT hetu_hmac, authenticated_at, standing FROM identity ORDER BY authenticated_at DESC NULLS LAST LIMIT 5",
      );
      for (const r of rows) {
        console.log(`${r.hetu_hmac} ${r.authenticated_at?.toISOString() ?? "never"} ${r.standing}`);
      }
      if (rows.length === 0) console.log("no identities");
      return 0;
    }
    if (command === "list") {
      const { rows } = await pool.query<{
        hetu_hmac: string;
        role: string;
        granted_at: Date;
        granted_by: string;
      }>(
        `SELECT i.hetu_hmac, m.role, m.granted_at, m.granted_by FROM moderator_roles m JOIN identity i ON i.id = m.identity_id ORDER BY m.granted_at`,
      );
      for (const r of rows)
        console.log(
          `${r.role.padEnd(10)} ${r.hetu_hmac} granted ${r.granted_at.toISOString()} by ${r.granted_by}`,
        );
      if (rows.length === 0) console.log("no staff roles");
      return 0;
    }
    if (!hetuHmac || !/^[0-9a-f]{64}$/i.test(hetuHmac)) {
      console.error(
        "usage: moderator grant <hetu_hmac> <role> --by <name> | revoke <hetu_hmac> | list",
      );
      return 2;
    }
    const identity = await pool.query<{ id: string; standing: string }>(
      "SELECT id, standing FROM identity WHERE hetu_hmac = $1",
      [hetuHmac],
    );
    const found = identity.rows[0];
    if (!found) {
      console.error("no identity with that hetu_hmac: the person has to have logged in once");
      return 1;
    }
    if (command === "grant") {
      const by = arg("--by");
      if (!role || !ROLES.has(role) || !by) {
        console.error(
          "usage: moderator grant <hetu_hmac> <moderator|admin|researcher> --by <name>",
        );
        return 2;
      }
      // The staff list's contract holds the name to 200 characters (#310).
      if (by.length > GRANTOR_MAX) {
        console.error(`--by is a name of at most ${GRANTOR_MAX} characters`);
        return 2;
      }
      if (found.standing !== "ok") {
        console.error(`identity standing is ${found.standing}; not granting`);
        return 1;
      }
      await pool.query(
        `INSERT INTO moderator_roles (identity_id, role, granted_by) VALUES ($1, $2, $3)
         ON CONFLICT (identity_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, granted_at = now()`,
        [found.id, role, by],
      );
      console.log(`granted ${role}`);
      return 0;
    }
    const result = await transaction(pool, async (tx) => {
      const removed = await tx.query("DELETE FROM moderator_roles WHERE identity_id = $1", [
        found.id,
      ]);
      // A later grant must not revive sessions that belonged to the revoked role.
      await tx.query(
        "UPDATE admin_session SET revoked_at = now() WHERE identity_id = $1 AND revoked_at IS NULL",
        [found.id],
      );
      return removed;
    });
    console.log(result.rowCount === 1 ? "revoked" : "no role to revoke");
    return 0;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main();
