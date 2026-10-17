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
 * Refuses production unless --env production is given on purpose, like the seed.
 */
import { createPool } from "../pool.ts";

const ROLES = new Set(["moderator", "admin", "researcher"]);
/** As long as the staff list may show the name of who granted a role (StaffMember.grantedBy). */
const GRANTOR_MAX = 200;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** The flags that take the word after them as their value. */
const VALUED = new Set(["--by", "--env"]);

/**
 * The words that are not a flag or a flag's value, by position: a role that
 * happens to equal the --by name ("grant <hmac> admin --by admin") stays the
 * role (#250, #310). The bare "--" pnpm passes through ("moderator -- list")
 * is no flag and takes nothing with it.
 */
function positionals(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    if (VALUED.has(word)) i++;
    else if (!word.startsWith("--")) out.push(word);
  }
  return out;
}

async function main(): Promise<number> {
  const [command, hetuHmac, role] = positionals(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    return 2;
  }
  const env = arg("--env") ?? process.env.APP_ENV ?? "development";
  if (env === "production" && arg("--env") !== "production") {
    console.error("refusing production without --env production");
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
    if (command === "revoke") {
      const result = await pool.query("DELETE FROM moderator_roles WHERE identity_id = $1", [
        found.id,
      ]);
      // Every live admin session of that identity ends with the role (the guard re-reads it), but the rows go too.
      await pool.query(
        "UPDATE admin_session SET revoked_at = now() WHERE identity_id = $1 AND revoked_at IS NULL",
        [found.id],
      );
      console.log(result.rowCount === 1 ? "revoked" : "no role to revoke");
      return 0;
    }
    console.error(
      "usage: moderator grant <hetu_hmac> <role> --by <name> | revoke <hetu_hmac> | list",
    );
    return 2;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main();
