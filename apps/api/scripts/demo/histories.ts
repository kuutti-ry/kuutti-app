import { type Queryable, transaction } from "@kuutti/db";
import {
  type DemoPersona,
  MOCK_BANK_AMR,
  OLDER_TERMS_VERSION,
  type PersonaHistory,
  personaOf,
} from "@kuutti/db/demo";
import {
  ConsentsResponse,
  type Gender,
  OnboardingStatus,
  PondList,
  type PreferencesUpdate,
  type ProfileUpdate,
  SessionResponse,
} from "@kuutti/schema";
import { type BankContext, call, DemoError, loginAs, upload } from "./bank.ts";
import { approveLocally, type PhotoAssets, picturesOf } from "./photos.ts";

/**
 * Gives a persona its history (#73, ADR-014 §12; on staging #141, ADR-018):
 * the answers of onboarding and the profile in the order the app sends them,
 * then what no route does, because no person can do it, in the database:
 * an older wording of the terms, and a ban. The story is one; the hands are
 * two. Locally the writer logs the persona in at the mock bank and calls the
 * API's own routes (`viaRoutes`). In the staging container the writer
 * registers the persona as the callback would and calls the service
 * functions the routes call (`viaServices`, services.ts).
 */
export type HistoryContext = BankContext & { db: Queryable; assets?: PhotoAssets };

export type Locale = PersonaHistory["locale"];
export type HistoryConsentKind = "terms" | "privacy" | "special_category";
export type HistoryLogin =
  | { accountId: string; outcome: "created" | "resumed" }
  | { refused: string };

export type HistoryWriter = {
  db: Queryable;
  now: () => Date;
  /** The release's pictures, verified; absent while there is none, and nobody gets a photo. */
  assets?: PhotoAssets;
  /** The persona's way in: a bank login, or the registration the job does in its stead. */
  login(persona: DemoPersona, locale: Locale): Promise<HistoryLogin>;
  currentVersions(accountId: string): Promise<Record<HistoryConsentKind, string>>;
  consent(
    accountId: string,
    kind: HistoryConsentKind,
    version: string,
    locale: Locale,
  ): Promise<void>;
  gender(accountId: string, gender: Gender): Promise<void>;
  preferences(accountId: string, update: PreferencesUpdate): Promise<void>;
  pond(accountId: string, slug: string): Promise<void>;
  profile(accountId: string, update: ProfileUpdate): Promise<void>;
  /** The pictures through the upload pipeline (rule 4), as anybody's; the ids, in order. */
  photos(accountId: string, pictures: readonly Uint8Array[]): Promise<string[]>;
  /** The look a moderator gives the faces of a story where no check decides; nothing where one does. */
  approve(accountId: string, photoIds: readonly string[]): Promise<void>;
  status(accountId: string): Promise<OnboardingStatus>;
  deleteAccount(accountId: string): Promise<void>;
  logout(accountId: string): Promise<void>;
  /**
   * SQL that names the persona's identity, as `i`, beside the account `a`
   * ($1 is the account id; the clause's own parameters start at $2): the two
   * direct writes carry it, so whatever the API answered, no other account is
   * touched.
   */
  whoIs(history: PersonaHistory): { clause: string; params: readonly unknown[] };
};

export type HistoryResult = {
  key: string;
  /** Pictures uploaded for the persona this time: faces and negatives. */
  photos: number;
  /** `already`: the story's own ending (a ban, a deletion) refused the login, so it was told before. */
  login: "created" | "resumed" | "already";
  onboarded: boolean;
  profile: boolean;
  afterwards: PersonaHistory["afterwards"];
};

/** The local hands (ADR-014 §12): a login at the mock bank, then the routes, as the app calls them. */
export function viaRoutes(context: HistoryContext): HistoryWriter {
  const tokens = new Map<string, string>();
  const as = (
    accountId: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ) => {
    const token = tokens.get(accountId);
    if (!token) throw new DemoError(`no session for ${accountId}: the login comes first`);
    return call(context, token, method, path, body);
  };
  return {
    db: context.db,
    now: context.now,
    ...(context.assets ? { assets: context.assets } : {}),
    async login(persona, locale) {
      const login = await loginAs(persona, context, locale);
      if (login.kind === "refused") return { refused: login.error };
      const { accountId } = SessionResponse.parse(
        await call(context, login.accessToken, "GET", "/auth/session"),
      );
      tokens.set(accountId, login.accessToken);
      return { accountId, outcome: login.outcome };
    },
    async currentVersions(accountId) {
      return ConsentsResponse.parse(await as(accountId, "GET", "/consents")).currentVersions;
    },
    async consent(accountId, kind, version, locale) {
      await as(accountId, "POST", "/consents", { kind, version, locale });
    },
    async gender(accountId, gender) {
      await as(accountId, "PUT", "/account/gender", { gender });
    },
    async preferences(accountId, update) {
      await as(accountId, "PUT", "/preferences", update);
    },
    async pond(accountId, slug) {
      const { ponds } = PondList.parse(await as(accountId, "GET", "/ponds"));
      const pond = ponds.find((p) => p.slug === slug);
      if (!pond) throw new DemoError(`no pond ${slug}: run the seed first`);
      await as(accountId, "PUT", "/account/pond", { pondId: pond.id });
    },
    async profile(accountId, update) {
      await as(accountId, "PUT", "/profile", update);
    },
    async photos(accountId, pictures) {
      const token = tokens.get(accountId);
      if (!token) throw new DemoError(`no session for ${accountId}: the login comes first`);
      const ids: string[] = [];
      for (const bytes of pictures) ids.push((await upload(context, token, bytes)).id);
      return ids;
    },
    async approve(accountId, photoIds) {
      // Locally the check queues everything (ADR-006): the look a moderator gives, by a named statement.
      await approveLocally(context.db, accountId, photoIds);
    },
    async status(accountId) {
      return OnboardingStatus.parse(await as(accountId, "GET", "/onboarding"));
    },
    async deleteAccount(accountId) {
      await as(accountId, "POST", "/account/delete", { confirm: true });
    },
    async logout(accountId) {
      await as(accountId, "POST", "/auth/logout");
    },
    // A persona is known by what the mock bank called it: the subject is the persona's name and the method is the mock bank's.
    whoIs: (history) => ({
      clause: "i.broker_subject = $2 AND $3 = ANY(i.amr)",
      params: [history.key, MOCK_BANK_AMR],
    }),
  };
}

export async function giveHistory(
  history: PersonaHistory,
  writer: HistoryWriter,
): Promise<HistoryResult> {
  const persona = personaOf(history);
  const login = await writer.login(persona, history.locale);
  if ("refused" in login) {
    // On staging the job runs again without a reset (ADR-018): a persona
    // whose story ends in a ban or a deletion is refused as the story says.
    const asTold =
      (history.afterwards === "banned" && login.refused === "auth_banned") ||
      (history.afterwards === "deleted" && login.refused === "auth_cooldown");
    if (asTold) {
      return {
        key: history.key,
        photos: 0,
        onboarded: history.onboarding !== null,
        profile: history.profile !== null,
        afterwards: history.afterwards,
        login: "already",
      };
    }
    throw new DemoError(
      `${history.key} is refused at the login (${login.refused}): reset the personas first`,
    );
  }
  const { accountId } = login;
  const told = {
    key: history.key,
    photos: 0,
    onboarded: history.onboarding !== null,
    profile: history.profile !== null,
    afterwards: history.afterwards,
  };
  // A live account was given its story before: resumed, never retold, so a
  // later run of the job changes nothing (ADR-018 §5); the reset forgets a
  // persona and tells its story anew.
  if (login.outcome === "resumed") return { ...told, login: "resumed" };

  if (history.onboarding) {
    const versions = await writer.currentVersions(accountId);
    for (const kind of ["terms", "privacy"] as const) {
      await writer.consent(accountId, kind, versions[kind], history.locale);
    }
    await writer.gender(accountId, history.onboarding.gender);
    // The seek answer needs the special-category consent first (ADR-019 §4, #146).
    await writer.consent(accountId, "special_category", versions.special_category, history.locale);
    await writer.preferences(accountId, {
      seeks: history.onboarding.seeks,
      ageWindow: history.onboarding.ageWindow,
    });
    await writer.pond(accountId, history.onboarding.pond);
  }
  if (history.profile) await writer.profile(accountId, history.profile);
  // The pictures (#142), through the pipeline like anybody's: the faces of the
  // story approved where no check decides, the negatives left to the queue.
  // Without the release nobody gets a photo, and the profile says so.
  let photos = 0;
  if (writer.assets && (history.photos > 0 || (history.negatives?.length ?? 0) > 0)) {
    const pictures = picturesOf(writer.assets, history);
    const faces = await writer.photos(accountId, pictures.faces);
    await writer.approve(accountId, faces);
    const negatives = await writer.photos(accountId, pictures.negatives);
    photos = faces.length + negatives.length;
  }
  if (history.onboarding) {
    // The app reads its onboarding after the last answer, and that reading is
    // what makes the account active (ADR-010): the persona's app has done it.
    const status = await writer.status(accountId);
    if (status.state !== "active") {
      throw new DemoError(`${history.key} did not become active: ${status.missing.join(", ")}`);
    }
  }

  // What no route does. Each statement names the account the writer said this
  // is and, beside it, the persona's identity as the writer knows it: whatever
  // was answered, no other account is touched. And each must have met its row:
  // an API that serves another database than this one is said, not passed over.
  const at = writer.now();
  const who = writer.whoIs(history);
  const next = `$${who.params.length + 2}`;
  const ofPersona = `account_id IN (SELECT a.id FROM account a JOIN identity i ON i.id = a.identity_id
     WHERE a.id = $1 AND ${who.clause})`;
  const params = [accountId, ...who.params];
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
      const changed = await writer.db.query(
        `UPDATE consent SET version = ${next} WHERE kind = 'terms' AND ${ofPersona}`,
        [...params, OLDER_TERMS_VERSION],
      );
      met("the older wording", changed.rowCount);
      break;
    }
    case "banned":
      // What a moderator's decision will write (M4): the sanction is on the
      // identity, so a new login finds it; the account and its sessions end.
      await transaction(writer.db, async (tx) => {
        const banned = await tx.query(
          `UPDATE identity AS i SET standing = 'banned', standing_changed_at = ${next}
           WHERE ${who.clause} AND i.id = (SELECT identity_id FROM account WHERE id = $1)`,
          [...params, at],
        );
        met("the ban", banned.rowCount);
        const ended = await tx.query(
          `UPDATE account SET state = 'banned', state_changed_at = ${next}
           WHERE id = $1 AND identity_id IN (SELECT i.id FROM identity i WHERE ${who.clause})`,
          [...params, at],
        );
        met("the account's end", ended.rowCount);
        await tx.query(`DELETE FROM session WHERE ${ofPersona}`, params);
      });
      break;
    case "deleted":
      await writer.deleteAccount(accountId);
      break;
    case "nothing":
      break;
  }
  // The writer's own device leaves; a ban and a deletion have ended it already.
  if (history.afterwards === "nothing" || history.afterwards === "older_terms") {
    await writer.logout(accountId);
  }
  return { ...told, photos, login: login.outcome };
}
