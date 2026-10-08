import { type Queryable, transaction } from "@kuutti/db";
import {
  MOCK_BANK_AMR,
  OLDER_TERMS_VERSION,
  type PersonaHistory,
  personaOf,
} from "@kuutti/db/demo";
import { ConsentsResponse, OnboardingStatus, PondList, SessionResponse } from "@kuutti/schema";
import { type BankContext, call, DemoError, loginAs } from "./bank.ts";

/**
 * Gives a persona its history (#73, ADR-014 §12): a login at the mock bank,
 * then the answers of onboarding and the profile through the API's own
 * routes, as the app sends them. What no route does, because no person can
 * do it, is done in the database afterwards and named here: an older wording
 * of the terms, and a ban.
 */
export type HistoryContext = BankContext & { db: Queryable };

export type HistoryResult = {
  key: string;
  login: "created" | "resumed";
  onboarded: boolean;
  profile: boolean;
  afterwards: PersonaHistory["afterwards"];
};

export async function giveHistory(
  history: PersonaHistory,
  context: HistoryContext,
): Promise<HistoryResult> {
  const persona = personaOf(history);
  const login = await loginAs(persona, context, history.locale);
  if (login.kind === "refused") {
    throw new DemoError(
      `${history.key} is refused at the login (${login.error}): reset the personas first`,
    );
  }
  const as = (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) =>
    call(context, login.accessToken, method, path, body);

  const { accountId } = SessionResponse.parse(await as("GET", "/auth/session"));

  if (history.onboarding) {
    const { currentVersions } = ConsentsResponse.parse(await as("GET", "/consents"));
    for (const kind of ["terms", "privacy"] as const) {
      await as("POST", "/consents", {
        kind,
        version: currentVersions[kind],
        locale: history.locale,
      });
    }
    await as("PUT", "/account/gender", { gender: history.onboarding.gender });
    // The seek answer needs the special-category consent first (ADR-019 §4, #146).
    await as("POST", "/consents", {
      kind: "special_category",
      version: currentVersions.special_category,
      locale: history.locale,
    });
    await as("PUT", "/preferences", {
      seeks: history.onboarding.seeks,
      ageWindow: history.onboarding.ageWindow,
    });
    const { ponds } = PondList.parse(await as("GET", "/ponds"));
    const pond = ponds.find((p) => p.slug === history.onboarding?.pond);
    if (!pond) throw new DemoError(`no pond ${history.onboarding.pond}: run the seed first`);
    await as("PUT", "/account/pond", { pondId: pond.id });
  }
  if (history.profile) await as("PUT", "/profile", history.profile);
  if (history.onboarding) {
    // The app reads its onboarding after the last answer, and that reading is
    // what makes the account active (ADR-010): the persona's app has done it.
    const status = OnboardingStatus.parse(await as("GET", "/onboarding"));
    if (status.state !== "active") {
      throw new DemoError(`${history.key} did not become active: ${status.missing.join(", ")}`);
    }
  }

  // What no route does. Each statement names the account the API said this
  // session is of and, beside it, the persona at the mock bank: whatever the
  // API answers, no other account is touched. And each must have met its
  // row: an API that serves another database than this one is said, not
  // passed over.
  const at = context.now();
  const ofPersona = `account_id IN (SELECT a.id FROM account a JOIN identity i ON i.id = a.identity_id
     WHERE a.id = $1 AND i.broker_subject = $2 AND $3 = ANY(i.amr))`;
  const who = [accountId, history.key, MOCK_BANK_AMR];
  const met = (what: string, rows: number | null) => {
    if (rows !== 1) {
      throw new DemoError(
        `${history.key}: ${what} met ${rows ?? 0} rows, not one: does the API serve the database of DATABASE_URL?`,
      );
    }
  };
  switch (history.afterwards) {
    case "older_terms": {
      // The wording moved on after she agreed: her consent names a version
      // that is no longer the one in force, and the app asks again.
      const changed = await context.db.query(
        `UPDATE consent SET version = $4 WHERE kind = 'terms' AND ${ofPersona}`,
        [...who, OLDER_TERMS_VERSION],
      );
      met("the older wording", changed.rowCount);
      break;
    }
    case "banned":
      // What a moderator's decision will write (M4): the sanction is on the
      // identity, so a new login finds it; the account and its sessions end.
      await transaction(context.db, async (tx) => {
        const banned = await tx.query(
          `UPDATE identity SET standing = 'banned', standing_changed_at = $4
           WHERE broker_subject = $2 AND $3 = ANY(amr)
             AND id = (SELECT identity_id FROM account WHERE id = $1)`,
          [...who, at],
        );
        met("the ban", banned.rowCount);
        const ended = await tx.query(
          `UPDATE account SET state = 'banned', state_changed_at = $4
           WHERE id = $1 AND identity_id IN
             (SELECT id FROM identity WHERE broker_subject = $2 AND $3 = ANY(amr))`,
          [...who, at],
        );
        met("the account's end", ended.rowCount);
        await tx.query(`DELETE FROM session WHERE ${ofPersona}`, who);
      });
      break;
    case "deleted":
      await as("POST", "/account/delete", { confirm: true });
      break;
    case "nothing":
      break;
  }
  // The script's own device leaves; a ban and a deletion have ended it already.
  if (history.afterwards === "nothing" || history.afterwards === "older_terms") {
    await as("POST", "/auth/logout");
  }
  return {
    key: history.key,
    login: login.outcome,
    onboarded: history.onboarding !== null,
    profile: history.profile !== null,
    afterwards: history.afterwards,
  };
}
