import { resolve } from "node:path";
import { createPool, migrate, type Pool, seed } from "@kuutti/db";
import { discoverProvider, type ProviderMetadata } from "@kuutti-ry/tunnistus-oidc";
import { type App, createApp } from "./app.ts";
import { archiveJob, createLive, type Live } from "./chat/index.ts";
import {
  brokerOptionsFromConfig,
  type IdentityBroker,
  OidcBroker,
  sweepAdminSessions,
  sweepSessions,
  teliaKeyIds,
} from "./identity/index.ts";
import { invitationCountJob } from "./jobs/invitation-count.ts";
import type { NightlyJob } from "./jobs/nightly.ts";
import { gateJob } from "./jobs/pond-gate.ts";
import { roundsJob } from "./jobs/round-builder.ts";
import type { RoundPushDeps } from "./jobs/round-push.ts";
import { ensureFirstSnapshot, waitlistJob } from "./jobs/waitlist-snapshot.ts";
import type { Config } from "./lib/config.ts";
import type { Logger } from "./lib/logger.ts";
import { mailerFor } from "./lib/mail.ts";
import { ensurePreviewDatabase } from "./lib/preview-database.ts";
import { pusherFor } from "./lib/push.ts";
import { createS3Client } from "./lib/s3.ts";
import { initSentry, sentryReporter } from "./lib/sentry.ts";
import { createMediaDeps, rejectUnreviewedPhotos, sweepPendingPhotos } from "./media/index.ts";
import { createPush } from "./notifications/index.ts";
import {
  copiedBeforeDrop,
  ensureEventPartitions,
  researchAnonymityJob,
  researchCopyJob,
  researchEventsJob,
  s3CopyStore,
} from "./research/index.ts";
import {
  auditBoundary,
  endSuspensions,
  prunePhotoCheckNotes,
  pruneReports,
} from "./safety/index.ts";

export type BootOptions = {
  config: Config;
  logger: Logger;
  /** The broker's discovery document; tests hand in a stub or the Telia double's, never the network. */
  discover?: (issuer: string) => Promise<ProviderMetadata>;
  /** The bank-login broker from its options; tests hand in one over the Telia double's fetch. */
  createBroker?: (options: Parameters<typeof OidcBroker.create>[0]) => Promise<IdentityBroker>;
};

export type Booted = {
  app: App;
  pool: Pool;
  jobs: NightlyJob[];
  live: Live;
  /** The round's push on its own timer, which index.ts arms (#102, ADR-055 §6). */
  roundPush: RoundPushDeps;
};

/**
 * Everything between a validated configuration and a server that may listen:
 * error reporting, the bank's discovery, the preview's database, the pool and
 * its migrations, media, the app and the nightly jobs. index.ts is the
 * process around it (the configuration's exit, the server, the signals), so
 * every step here runs in a test against a real database.
 */
export async function boot({
  config,
  logger,
  discover = discoverProvider,
  createBroker = (options) => OidcBroker.create(options),
}: BootOptions): Promise<Booted> {
  // Error reporting is on exactly when a DSN is configured (#11).
  const reporting = initSentry(config);
  logger.info({ reporting, environment: config.APP_ENV }, "error reporting");
  if (reporting && config.SENTRY_SELF_TEST) {
    sentryReporter()(new Error("Sentry self-test: the API booted with SENTRY_SELF_TEST=true"), {
      requestId: "self-test",
    });
    logger.warn("Sentry self-test event sent; unset SENTRY_SELF_TEST and redeploy");
  }

  // Bank identification (#32): the broker's endpoints and keys come from its
  // discovery document, read here so that a wrong issuer, a broker outage or a
  // misconfigured environment is a failed boot on staging and production, and
  // a warning locally, never a failed login later. The kit's discovery refuses
  // a document on Telia's host without private_key_jwt, the only client
  // authentication Telia offers (guide 2.6), and the kit's client a Telia
  // issuer without the level to ask for (Traficom 213/2023 S) or a key under
  // 2048 bits (guide 2.1.1).
  let broker: IdentityBroker | undefined;
  if (config.OIDC_ISSUER) {
    // The step that failed names the cause in the local warning: the error's
    // own message is redacted from every line (lib/logger.ts), and a fixed
    // name of ours carries nothing a configuration or a broker wrote (#235).
    // "configuration" is our own parameters, keys read included; "broker" is
    // making the client, which also refuses a Telia issuer without our keys.
    let stage: "discovery" | "configuration" | "broker" = "discovery";
    try {
      const provider = await discover(config.OIDC_ISSUER);
      // The key ids below read our keys, which a mis-pasted PEM fails.
      stage = "configuration";
      logger.info(
        {
          issuer: provider.issuer,
          authorizationEndpoint: provider.authorization_endpoint,
          tokenEndpoint: provider.token_endpoint,
          jwksUri: provider.jwks_uri,
          acrValues: config.OIDC_ACR_VALUES ?? null,
          // The kids (RFC 7638 thumbprints) of our two keys: what the JWKs
          // given to Telia must carry. Public values.
          keys: teliaKeyIds(config),
        },
        "bank identification",
      );
      const options = brokerOptionsFromConfig(config);
      if (options && config.HETU_HMAC_KEY) {
        stage = "broker";
        broker = await createBroker(options);
      } else {
        // Half a configuration is a misnamed parameter, not a choice: a
        // deployed box must not boot healthy with the login answering 503.
        throw new Error(
          "bank identification off: OIDC_CLIENT_ID, OIDC_REDIRECT_URI or HETU_HMAC_KEY is not set",
        );
      }
    } catch (error) {
      if (config.APP_ENV === "development" || config.APP_ENV === "test") {
        logger.warn(
          { err: error, stage },
          "bank identification unavailable; is the mock IdP running?",
        );
      } else {
        throw error;
      }
    }
  } else {
    logger.warn("bank identification off: OIDC_ISSUER is not set");
  }

  // A pull-request preview serves from its own kuutti_pr_<n> on the staging
  // instance, created here on first boot and dropped by preview-cleanup.yml
  // when the pull request closes (#9, TD-19). Never a copy of anything.
  if (config.preview) {
    const admin = createPool({
      connectionString: config.preview.adminDatabaseUrl,
      max: 1,
      applicationName: `kuutti-api-preview-${config.preview.prNumber}-setup`,
    });
    try {
      const state = await ensurePreviewDatabase(admin, config.preview.database);
      logger.info({ database: config.preview.database, state }, "preview database");
    } finally {
      await admin.end();
    }
  }

  const pool = createPool({
    connectionString: config.databaseUrl,
    max: config.DB_POOL_MAX,
    applicationName: `kuutti-api-${config.APP_ENV}`,
  });
  // An idle client the server drops (an RDS reboot or failover) is reported
  // here; pg-pool discards it and connects again on demand. Without a listener
  // the event is an uncaught exception and the process exits. The code and the
  // error's class only: the error carries its client, connection parameters
  // included, and its message is redacted from every line (lib/logger.ts, #235).
  // The class, not `name`: pg's DatabaseError names itself after the protocol
  // message, "error", where its class says it came from the server.
  pool.on("error", (error: Error & { code?: string }) => {
    logger.error(
      { code: error.code, type: error.constructor.name },
      "idle database client dropped",
    );
  });

  // Migrations run before the server listens, under the advisory lock (rule 10).
  const migration = await migrate(pool, resolve(config.MIGRATIONS_DIR));
  logger.info(migration, "migrations");
  // The events table's partitions for this month and the next (#50, ADR-011), before anything can track.
  logger.info(await ensureEventPartitions(pool, new Date()), "research event partitions");
  // The audit table's role boundary (#49, ADR-006) is set by the maintainer,
  // not by a migration: a deployed box says so at every boot until it is.
  const audit = await auditBoundary(pool);
  // A preview runs as kuutti_preview, owner of its own throwaway database: no boundary there by design.
  if (!audit.enforced && (config.APP_ENV === "staging" || config.APP_ENV === "production")) {
    logger.warn(audit, "audit boundary not enforced: run infra/scripts/db-audit-owner.sh");
  } else {
    logger.info(audit, "audit boundary");
  }

  // Previews are always seeded (rules/db.md); the seed is idempotent, so every
  // boot converges on the same ponds and matching_config.
  if (config.preview) {
    const seeded = await seed(pool, `preview-pr-${config.preview.prNumber}`);
    logger.info(seeded, "seed");
  }

  // Photos (#48): the bucket and the URL signer, or nothing and the photo
  // routes answer 503. A deployed environment with MEDIA_URL_BASE but no key
  // fails here rather than serving photos nobody can open; the private key
  // itself never appears in the log line (keyPairId is the public half's id).
  const media = createMediaDeps(config);
  if (media.setup.mode === "off" && config.APP_ENV !== "development" && config.APP_ENV !== "test") {
    logger.warn(media.setup, "photos off: media delivery is not configured (infra/modules/media)");
  } else {
    logger.info(media.setup, "media");
  }

  // The chat's sockets (#349): the app serves them, index.ts feeds them from the listener.
  const live = createLive({
    db: pool,
    logger,
    socketsPerAccount: config.WS_SOCKETS_PER_ACCOUNT,
  });
  // Mail (#385, ADR-043): SES on AWS, the log locally, none where MAIL is off.
  const mailer = mailerFor(config, logger);
  logger.info({ mail: config.MAIL }, "mail");
  // Push (#102, ADR-055 §8): Expo, the log locally, none where PUSH is off.
  const pusher = pusherFor(config, logger);
  logger.info({ push: config.PUSH, authenticated: Boolean(config.EXPO_ACCESS_TOKEN) }, "push");
  const app = createApp({
    live,
    config,
    logger,
    db: pool,
    ...(reporting ? { report: sentryReporter() } : {}),
    ...(broker ? { broker } : {}),
    ...(media.deps ? { media: media.deps } : {}),
    ...(mailer ? { mailer } : {}),
    ...(pusher ? { pusher } : {}),
  });
  // Nightly housekeeping inside the process (rules/api.md): ended sessions and
  // stale login attempts (#35).
  const now = () => new Date();
  // The research copy (#194, ADR-029) goes to the bucket the photos use, under
  // research/, wherever media has one: on staging and beside a developer's
  // stand-in, never in a preview, whose media is off (lib/config.ts), and
  // never where nothing is configured.
  // shortcut: none in production either. The copy keeps the research_id past
  // the ninety days the research text promises, and whether the text or the
  // copy changes is the maintainer's (ADR-029, Open); his answer lifts this.
  const copy =
    media.setup.mode === "off" || config.APP_ENV === "production"
      ? undefined
      : { db: pool, now, store: s3CopyStore(createS3Client(config), config.S3_BUCKET) };
  const jobs: NightlyJob[] = [
    { name: "sweep-sessions", run: () => sweepSessions({ db: pool, now }) },
    { name: "sweep-admin-sessions", run: () => sweepAdminSessions({ db: pool, now }) },
    // Yesterday's research events to the copy, before the prune can drop a month of them (#194).
    ...(copy ? [researchCopyJob(copy)] : []),
    // Next month's events partition ready, months past retention dropped (#50),
    // a month's copy checked first where there is one (ADR-029 §6).
    researchEventsJob({
      db: pool,
      now,
      ...(copy ? { beforeDrop: (months) => copiedBeforeDrop({ ...copy, logger }, months) } : {}),
    }),
    // The census of the research block: a cell under k is a warning (ADR-011 §9).
    researchAnonymityJob({ db: pool, logger }),
    // Suspensions past their day end (#307, ADR-024 §5), before the counter
    // and the gate, so a person let back in is counted the same night.
    { name: "end-suspensions", run: async () => ({ ended: await endSuspensions(pool, now()) }) },
    // The day's waitlist figures (#54): taken once a day, served all day.
    waitlistJob({ db: pool, logger, now }),
    // Who is let into each pond, and for whom matching opens (#94).
    gateJob({ db: pool, logger, now }),
    // The invitations whose redeemer's profile the gate's count has seen tonight (#107, ADR-044 §7).
    invitationCountJob({ db: pool, logger, now }),
    // The day's round for everybody whose matching is open, after the gate (#95, ADR-035).
    // shortcut: none in production until the maintainer has set how long rounds
    // are kept (ADR-034 Open 2, ADR-035 Open 1); his answer lifts this and app.ts's twin.
    ...(config.APP_ENV === "production" ? [] : [roundsJob({ db: pool, logger, now })]),
    // A photo nobody decided in photo_queue_reject_days is rejected as not reviewed (#376),
    // wherever there is a queue, Rekognition or none.
    { name: "reject-unreviewed-photos", run: () => rejectUnreviewedPhotos({ db: pool, now }) },
    // The photo check's notes keep twelve months (#253).
    {
      name: "prune-photo-check-notes",
      run: async () => ({ pruned: await prunePhotoCheckNotes(pool, now()) }),
    },
    // Reports keep twelve months from filing, whoever was erased meanwhile (#84, ADR-030 §8),
    // and the photos of erased senders their copies held go with them (#351).
    {
      name: "prune-reports",
      run: () =>
        pruneReports(
          { db: pool, logger, ...(media.deps ? { store: media.deps.store } : {}) },
          now(),
        ),
    },
    // Conversations silent for silent_match_archive_days are put away (#348, TD-13).
    archiveJob({ db: pool, logger, now }),
  ];
  // Photos the automatic check missed get one more look (#49); none without a moderator.
  const mediaDeps = media.deps;
  const moderator = mediaDeps?.moderator;
  if (mediaDeps && moderator) {
    jobs.push({
      name: "moderate-pending-photos",
      run: () => sweepPendingPhotos({ db: pool, logger, now, moderator, store: mediaDeps.store }),
    });
  }
  // A database with no figures yet gets its first ones now, so the public route has a day to serve.
  // Logged, never thrown, like a nightly job: the counter is not worth a boot, and the night tries again.
  await ensureFirstSnapshot({ db: pool, logger, now }).catch((err: unknown) =>
    logger.error({ job: "waitlist-snapshot", err }, "first waitlist snapshot failed"),
  );

  // The round's push reads no socket: everybody it tells is out of today's round.
  const roundPush: RoundPushDeps = {
    db: pool,
    logger,
    now,
    push: createPush({
      db: pool,
      logger,
      now,
      ...(pusher ? { pusher } : {}),
      online: () => false,
    }),
  };
  return { app, pool, jobs, live, roundPush };
}
