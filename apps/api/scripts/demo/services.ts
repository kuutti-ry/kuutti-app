import type { Queryable } from "@kuutti/db";
import {
  assertArtificial,
  DEMO_PERSONAS,
  DEMO_SUBJECT_PREFIX,
  PERSONA_HISTORIES,
  personaHetu,
} from "@kuutti/db/demo";
import {
  CURRENT_CONSENT_VERSIONS,
  declareGender,
  deriveArtificialIdentity,
  eraseAccount,
  giveConsent,
  onboardingStatus,
  registerArtificial,
} from "../../src/identity/index.ts";
import type { Logger } from "../../src/lib/logger.ts";
import { readPreferences, savePreferences } from "../../src/matching/index.ts";
import { type MediaDeps, uploadPhoto } from "../../src/media/index.ts";
import { findPondBySlug, setPondOfAccount } from "../../src/pond/index.ts";
import { saveProfile } from "../../src/profile/index.ts";
import { DemoError } from "./bank.ts";
import { giveHistory, type HistoryResult, type HistoryWriter } from "./histories.ts";
import type { PhotoAssets } from "./photos.ts";

/**
 * The hands of the staging job (#141, ADR-018): inside the API's container,
 * where Telia's bed is the bank and no script drives it, a persona is
 * registered as the callback would register it, and its story is given
 * through the service functions the routes call. The code of a persona is
 * an artificial one (ADR-014 §3, `assertArtificial`), exists in the login's
 * memory for the derivation and is not logged; the key is the container's
 * configuration, read as the API reads it, and leaves nowhere (rule 2). The
 * persona's first real login at the test bank then finds the identity by the
 * same hash and resumes the live account.
 */
export type ServicesContext = {
  db: Queryable;
  logger: Logger;
  now: () => Date;
  hmacKey: Buffer;
  media?: MediaDeps;
  /** The release's pictures, verified (photos.ts); absent, nobody gets a photo. */
  assets?: PhotoAssets;
};

export function viaServices(context: ServicesContext): HistoryWriter {
  const { db, logger, now } = context;
  const onboarding = { db, logger, now };
  /** The hash of each persona logged in, by key: what the two direct writes name the identity by. */
  const hashes = new Map<string, string>();
  return {
    db,
    now,
    ...(context.assets ? { assets: context.assets } : {}),
    async login(persona) {
      assertArtificial(persona);
      const at = now();
      // The code is this call's argument and is kept by nothing; the identity
      // slice derives, decides and writes as the callback would (ADR-018 §2).
      const registered = await registerArtificial(db, {
        hetu: personaHetu(persona, at),
        key: context.hmacKey,
        subject: `${DEMO_SUBJECT_PREFIX}${persona.key}`,
        now: at,
      });
      hashes.set(persona.key, registered.hetuHmac);
      if (registered.kind === "refused") return { refused: `auth_${registered.reason}` };
      return { accountId: registered.accountId, outcome: registered.kind };
    },
    async currentVersions() {
      return CURRENT_CONSENT_VERSIONS;
    },
    async consent(accountId, kind, version, locale) {
      await giveConsent(onboarding, accountId, { kind, version, locale });
    },
    async gender(accountId, gender) {
      await declareGender(onboarding, accountId, gender);
    },
    async preferences(accountId, update) {
      if (!(await savePreferences(db, accountId, update, now()))) {
        throw new DemoError(`${accountId}: no live account for the preferences`);
      }
    },
    async pond(accountId, slug) {
      const pond = await findPondBySlug(db, slug);
      if (!pond) throw new DemoError(`no pond ${slug}: run the seed first`);
      if ((await setPondOfAccount(db, accountId, pond.id)) !== "set") {
        throw new DemoError(`${accountId}: the pond could not be set`);
      }
    },
    async profile(accountId, update) {
      await saveProfile({ db, logger, now, readPreferences }, accountId, update);
    },
    async photos(accountId, pictures) {
      if (!context.media) {
        throw new DemoError("no object store is configured, and the stories have pictures");
      }
      const deps = { ...context.media, db, logger, now };
      const ids: string[] = [];
      for (const bytes of pictures) ids.push((await uploadPhoto(deps, { accountId, bytes })).id);
      return ids;
    },
    async approve() {
      // The check the container is configured with decides (Rekognition on
      // staging, ADR-018 §8); nothing is approved by hand here.
    },
    async status(accountId) {
      return onboardingStatus(onboarding, accountId);
    },
    async deleteAccount(accountId) {
      await eraseAccount(
        { db, logger, now, ...(context.media ? { media: context.media } : {}) },
        accountId,
      );
    },
    async logout() {
      // No session was opened: the job holds no device.
    },
    whoIs(history) {
      const hash = hashes.get(history.key);
      if (!hash) throw new DemoError(`${history.key}: no login before the history`);
      return { clause: "i.hetu_hmac = $2", params: [hash] };
    },
  };
}

/** Every persona by the hash the bed's login finds it by, on the day of `at`: what the staging reset forgets. */
export function personaHashes(hmacKey: Buffer, at: Date): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const persona of DEMO_PERSONAS) {
    assertArtificial(persona);
    hashes.set(
      deriveArtificialIdentity(personaHetu(persona, at), hmacKey, at).hetuHmac,
      persona.key,
    );
  }
  return hashes;
}

/** The six histories, in their order; a persona the caller names is left alone. */
export async function giveStories(
  writer: HistoryWriter,
  skip: readonly string[] = [],
): Promise<HistoryResult[]> {
  const results: HistoryResult[] = [];
  for (const history of PERSONA_HISTORIES) {
    if (skip.includes(history.key)) continue;
    results.push(await giveHistory(history, writer));
  }
  return results;
}
