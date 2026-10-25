import { type Queryable, transaction } from "@kuutti/db";
import type { ExportedPush, PushPlatform } from "@kuutti/schema";

// A device's push token (#102, ADR-055 §2, §3): one per session, a token in
// one session. It goes by itself when the session is revoked (migration
// 0082's trigger) or deleted (the cascade); erasure deletes the account's
// (erasePushTokensOf). Raw parameterised SQL, as in the rest of the slice.

/**
 * Registers the caller's session's token, worded in `locale`. The account is
 * held as every writer holds it (FOR SHARE), and the session row locked, so
 * an erasure or a revocation under way either finishes first and nothing is
 * written, or waits and then takes the row away; a session already revoked
 * or expired writes nothing.
 */
export async function registerPushToken(
  db: Queryable,
  input: {
    accountId: string;
    sessionId: string;
    token: string;
    platform: PushPlatform;
    locale: string;
    at: Date;
  },
): Promise<void> {
  await transaction(db, async (tx) => {
    const live = await tx.query(
      `SELECT 1 FROM account a JOIN session s ON s.account_id = a.id
        WHERE a.id = $1 AND a.state <> 'deleted' AND s.id = $2
          AND s.revoked_at IS NULL AND s.expires_at > $3
        FOR SHARE OF a FOR UPDATE OF s`,
      [input.accountId, input.sessionId, input.at],
    );
    if (live.rows.length === 0) return;
    // The session's earlier token, when the phone was given a new one.
    await tx.query(
      "DELETE FROM push_token WHERE account_id = $1 AND session_id = $2 AND token <> $3",
      [input.accountId, input.sessionId, input.token],
    );
    // The one statement here not scoped by the caller's account (rule 6, ADR-055 §2):
    // a token another session registered moves to this one, whoever's that session
    // was, since the device that holds the token now holds the caller's session. An
    // app reinstalled without a sign-out keeps its token on iOS, and the next person
    // to sign in on it must not get the earlier one's pushes. The same session's
    // registration keeps its first time, which the export says.
    await tx.query(
      `INSERT INTO push_token (account_id, session_id, token, platform, locale, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (token) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         session_id = EXCLUDED.session_id,
         platform = EXCLUDED.platform,
         locale = EXCLUDED.locale,
         created_at = CASE WHEN push_token.session_id = EXCLUDED.session_id
                           THEN push_token.created_at ELSE EXCLUDED.created_at END`,
      [input.accountId, input.sessionId, input.token, input.platform, input.locale, input.at],
    );
  });
}

/** Erasure (ADR-007 §4, ADR-055 §3): the account's tokens, before its sessions go and take them uncounted. */
export async function erasePushTokensOf(db: Queryable, accountId: string): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM push_token WHERE account_id = $1", [accountId]);
  return rowCount ?? 0;
}

/**
 * The export (ADR-055 §11): per session with a token, its platform, its
 * language and since when; never the token, which names the installation to
 * Expo, Apple and Google and could be sent to by whoever holds a copy.
 */
export async function exportPushTokens(
  db: Queryable,
  accountId: string,
): Promise<Map<string, ExportedPush>> {
  const { rows } = await db.query<{
    session_id: string;
    platform: PushPlatform;
    locale: ExportedPush["locale"];
    created_at: Date;
  }>("SELECT session_id, platform, locale, created_at FROM push_token WHERE account_id = $1", [
    accountId,
  ]);
  return new Map(
    rows.map((row) => [
      row.session_id,
      { platform: row.platform, locale: row.locale, registeredAt: row.created_at.toISOString() },
    ]),
  );
}
