import { resolve } from "node:path";
import { createPool, migrate, type Pool, seed } from "@kuutti/db";
import {
  DiscoveryError,
  discoverProvider,
  isTeliaIssuer,
  type ProviderMetadata,
} from "@kuutti/tunnistus-oidc";
import { type App, createApp } from "./app.ts";
import {
  brokerOptionsFromConfig,
  type IdentityBroker,
  OidcBroker,
  sweepAdminSessions,
  sweepSessions,
  teliaKeyIds,
} from "./identity/index.ts";
import type { NightlyJob } from "./jobs/nightly.ts";
import { gateJob } from "./jobs/pond-gate.ts";
import { ensureFirstSnapshot, waitlistJob } from "./jobs/waitlist-snapshot.ts";
import type { Config } from "./lib/config.ts";
import type { Logger } from "./lib/logger.ts";
import { ensurePreviewDatabase } from "./lib/preview-database.ts";
import { initSentry, sentryReporter } from "./lib/sentry.ts";
import { createMediaDeps, sweepPendingPhotos } from "./media/index.ts";
import {
  ensureEventPartitions,
  researchAnonymityJob,
  researchEventsJob,
} from "./research/index.ts";
import { auditBoundary, endSuspensions, prunePhotoCheckNotes } from "./safety/index.ts";

export type BootOptions = {
  config: Config;
  logger: Logger;
  /** The broker's discovery document; tests hand in a stub or the Telia double's, never the network. */
  discover?: (issuer: string) => Promise<ProviderMetadata>;
  /** The bank-login broker from its options; tests hand in one over the Telia double's fetch. */
  createBroker?: (options: Parameters<typeof OidcBroker.create>[0]) => Promise<IdentityBroker>;
};

export type Booted = { app: App; pool: Pool; jobs: NightlyJob[] };

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
  // a warning locally, never a failed login later. Telia offers private_key_jwt
  // only; a broker that does not is the wrong one.
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
      const methods = provider.token_endpoint_auth_methods_supported ?? [];
      if (isTeliaIssuer(config.OIDC_ISSUER) && !methods.includes("private_key_jwt")) {
        throw new DiscoveryError(config.OIDC_ISSUER, "no private_key_jwt at the token endpoint");
      }
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

  const app = createApp({
    config,
    logger,
    db: pool,
    ...(reporting ? { report: sentryReporter() } : {}),
    ...(broker ? { broker } : {}),
    ...(media.deps ? { media: media.deps } : {}),
  });
  // Nightly housekeeping inside the process (rules/api.md): ended sessions and
  // stale login attempts (#35). The round builder and the research export join here.
  const now = () => new Date();
  const jobs: NightlyJob[] = [
    { name: "sweep-sessions", run: () => sweepSessions({ db: pool, now }) },
    { name: "sweep-admin-sessions", run: () => sweepAdminSessions({ db: pool, now }) },
    // Next month's events partition ready, months past retention dropped (#50).
    researchEventsJob({ db: pool, now }),
    // The census of the research block: a cell under k is a warning (ADR-011 §9).
    researchAnonymityJob({ db: pool, logger }),
    // Suspensions past their day end (#307, ADR-024 §5), before the counter
    // and the gate, so a person let back in is counted the same night.
    { name: "end-suspensions", run: async () => ({ ended: await endSuspensions(pool, now()) }) },
    // The day's waitlist figures (#54): taken once a day, served all day.
    waitlistJob({ db: pool, logger, now }),
    // Who is let into each pond, and for whom matching opens (#94).
    gateJob({ db: pool, logger, now }),
    // The photo check's notes keep twelve months (#253).
    {
      name: "prune-photo-check-notes",
      run: async () => ({ pruned: await prunePhotoCheckNotes(pool, now()) }),
    },
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

  return { app, pool, jobs };
}
