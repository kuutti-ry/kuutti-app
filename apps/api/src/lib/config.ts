import { z } from "zod";
import { TRUSTED_PROXIES, type TrustedProxy } from "./rate-limit.ts";
import { loadSsmParameters } from "./ssm.ts";

const AppEnv = z.enum(["development", "test", "preview", "staging", "production"]);

/**
 * Every configuration value the process reads, validated once at boot. A
 * missing or invalid key fails the start, never a request. Secrets come from
 * SSM in deployed environments (TD-19); locally the runtime reads .env through
 * node's --env-file, and tooling never touches that file (rule 9).
 */
const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: AppEnv.default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  APP_VERSION: z.string().min(1).default("0.0.0-dev"),
  GIT_COMMIT: z.string().min(1).optional(),
  BUILT_AT: z.string().min(1).optional(),

  // Either the full URL, or the parts the SSM parameters carry (#7).
  DATABASE_URL: z.string().min(1).optional(),
  DB_HOST: z.string().min(1).optional(),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_NAME: z.string().min(1).optional(),
  DB_USER: z.string().min(1).optional(),
  DB_APP_PASSWORD: z.string().min(1).optional(),
  // The preview role (#9): CREATEDB, owner of every kuutti_pr_<n>, no
  // CONNECT on the environment's own database. Staging parameters only.
  DB_PREVIEW_USER: z.string().min(1).optional(),
  DB_PREVIEW_PASSWORD: z.string().min(1).optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  // RDS certificates chain to Amazon's private RDS roots, which no system
  // store carries; the image ships the eu-central-1 bundle (certs/) and sets
  // this path, so a composed URL verifies the server's certificate and name.
  // Unset means a local Postgres: sslmode=require, no verification.
  DB_SSL_ROOT_CERT: z.string().min(1).optional(),
  MIGRATIONS_DIR: z.string().min(1).default("../../packages/db/drizzle"),

  CORS_ALLOWED_ORIGINS: z.string().optional(),

  // Object storage: the compose S3 stand-in locally (env.example), S3 through the instance role on AWS.
  S3_ENDPOINT: z.string().min(1).optional(),
  S3_REGION: z.string().min(1).default("eu-central-1"),
  S3_BUCKET: z.string().min(1).default("kuutti-media"),
  S3_ACCESS_KEY: z.string().min(1).optional(),
  S3_SECRET_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Photo delivery (#48, TD-8, ADR-005): the distribution's origin
  // (https://api.<env>.kuutti.app; objects are signed under /media/), the id
  // of our CloudFront public key, and the private half from
  // /kuutti/<env>/cloudfront-signing-key. All three or none: with them URLs
  // are CloudFront signed URLs; without them a developer's stand-in presigns its
  // own, and a deployed environment has no photos (media/wiring.ts).
  // https only: a signed URL over plain HTTP would hand the picture and its
  // signature to the network, and no CloudFront distribution speaks HTTP to us.
  MEDIA_URL_BASE: z.url({ protocol: /^https$/ }).optional(),
  CLOUDFRONT_KEY_PAIR_ID: z
    .string()
    .regex(/^[A-Z0-9]{13,20}$/, "a CloudFront public key id")
    .optional(),
  CLOUDFRONT_SIGNING_KEY: z.string().min(1).optional(),
  // sharp runs this many uploads at once; above it the upload answers 503
  // (rules/api.md Media). Defaults to the vCPU count; tests set 1.
  IMAGE_CONCURRENCY: z.coerce.number().int().min(1).max(64).optional(),
  // Photo moderation (#49, ADR-006): rekognition through the instance role on
  // AWS (the SSM parameter `moderation`), queue everywhere else, which sends
  // every photo to a person and approves nothing by itself.
  MODERATION: z.enum(["rekognition", "queue"]).default("queue"),
  // Where a staff bank login returns to (#49): the moderation panel's origin,
  // which is also on the CORS allowlist. Vite's dev server by default.
  ADMIN_APP_URL: z.url().default("http://localhost:5173"),

  // Bank identification (M2, docs/vendors/telia.md): the mock IdP locally, the
  // Telia broker on staging and production. The issuer's endpoints and keys come
  // from discovery at boot, never from configuration: Telia rotates its keys on
  // its own schedule and nothing is pinned (rules/api.md).
  OIDC_ISSUER: z.url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_REDIRECT_URI: z.url().optional(),
  // acr_values of the signed request object, mandatory under Traficom 213/2023 S:
  // loa2 in production, loatest2 in Telia's pre-production; the mock accepts any.
  OIDC_ACR_VALUES: z.string().min(1).optional(),
  // Our two RSA private keys (PEM), from /kuutti/<env>/telia-signing-key and
  // /kuutti/<env>/telia-encryption-key: the first signs request objects and
  // client assertions, the second decrypts the ID token Telia encrypts to us.
  // Optional until the exchange lands (#33); never logged, never in .env.example.
  TELIA_SIGNING_KEY: z.string().min(1).optional(),
  TELIA_ENCRYPTION_KEY: z.string().min(1).optional(),
  // Verified links (#36): the release keystore's SHA-256 fingerprints (comma
  // separated, colon form as `eas credentials` prints them) for
  // /.well-known/assetlinks.json, and the Apple team id for the AASA. Public
  // values; unset means the file answers 404 and the return uses the scheme.
  ANDROID_CERT_FINGERPRINTS: z
    .string()
    .regex(
      /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){31}(\s*,\s*[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){31})*$/,
      "comma-separated SHA-256 fingerprints with colons",
    )
    .optional(),
  IOS_TEAM_ID: z
    .string()
    .regex(/^[A-Z0-9]{10}$/, "ten characters")
    .optional(),
  // The key of HMAC-SHA256(hetu), 32 bytes as hex, from /kuutti/<env>/hetu-hmac-key
  // (rule 2: fetched at boot, never rotated, one offline copy). Without it the
  // auth routes answer 503; the login never runs with a key from anywhere else.
  HETU_HMAC_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "32 bytes as hex")
    .optional(),
  // Error reporting (#11). A DSN is public by design: /kuutti/<env>/sentry-dsn
  // is a plain String parameter. Unset means the SDK stays off.
  SENTRY_DSN: z.url().optional(),
  // Set to "true" for one deploy to prove the Sentry wiring end to end: the
  // process reports a single marked error at boot and carries on (#11). Not a
  // route: nothing outside the box can trigger it (security checklist, no
  // debug routes outside development).
  SENTRY_SELF_TEST: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // AGPL-3.0 section 13 (#16): whoever runs a modified version as a service owes
  // its users the corresponding source. /health offers this URL with the running
  // commit, and the app and the admin panel show both. A fork that deploys
  // changes sets it to its own repository; https only, because it is a link
  // people are asked to follow.
  SOURCE_URL: z.url({ protocol: /^https$/ }).default("https://github.com/kuutti-ry/kuutti-app"),
  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(1_048_576),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).optional(),
  // Whose word the rate limiter takes for the client address (#52, F19,
  // lib/rate-limit.ts). Unset: the socket in development and test, Traefik on
  // a deployed box. /kuutti/<env>/trusted-proxy says cloudfront the day the
  // box admits CloudFront alone (cloudfront_only_ingress), never before.
  TRUSTED_PROXY: z.enum(TRUSTED_PROXIES).optional(),
  SSM_PARAMETER_PREFIX: z.string().min(1).optional(),

  // Pull-request preview (#9): the process creates and seeds kuutti_pr_<n>
  // on the staging instance and serves from it. Set only by the preview
  // deployment; refused outside APP_ENV=preview.
  PR_NUMBER: z
    .string()
    .regex(/^[0-9]{1,7}$/, "a pull request number")
    .optional(),
});

/** Previews throttle harder than staging: nothing real runs there (#9). */
const RATE_LIMIT_DEFAULT = { preview: 30, other: 120 } as const;

export type AppEnv = z.infer<typeof AppEnv>;

export type PreviewConfig = {
  prNumber: string;
  /** kuutti_pr_<n>: the database this process serves from, created on first boot. */
  database: string;
  /** The instance's maintenance database (postgres), used only to CREATE DATABASE. */
  adminDatabaseUrl: string;
};

export type Config = Omit<z.infer<typeof Env>, "RATE_LIMIT_PER_MINUTE" | "TRUSTED_PROXY"> & {
  RATE_LIMIT_PER_MINUTE: number;
  TRUSTED_PROXY: TrustedProxy;
  databaseUrl: string;
  corsAllowedOrigins: ReadonlySet<string>;
  preview?: PreviewConfig;
};

export class ConfigError extends Error {
  constructor(
    readonly missing: string[],
    readonly issues: string[],
  ) {
    super(`Invalid configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
  }
}

export function parseConfig(raw: Record<string, string | undefined>): Config {
  const result = Env.safeParse(raw);
  if (!result.success) {
    const missing = result.error.issues
      .filter((i) => i.code === "invalid_type" && i.input === undefined)
      .map((i) => i.path.join("."));
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(missing, issues);
  }
  const env = result.data;
  const preview = previewConfig(env);
  const baseUrl = env.DATABASE_URL ?? composeDatabaseUrl(env, preview !== undefined);
  if (!baseUrl) {
    throw new ConfigError(
      ["DATABASE_URL"],
      [
        preview
          ? "DATABASE_URL: set it, or set DB_HOST, DB_NAME, DB_PREVIEW_USER and DB_PREVIEW_PASSWORD"
          : "DATABASE_URL: set it, or set DB_HOST, DB_NAME, DB_USER and DB_APP_PASSWORD",
      ],
    );
  }
  // env.example's all-zero key is for the mock IdP only; a deployed process
  // that sees it has an env file where SSM should be (rule 2).
  if (
    env.HETU_HMAC_KEY !== undefined &&
    /^0+$/.test(env.HETU_HMAC_KEY) &&
    env.APP_ENV !== "development" &&
    env.APP_ENV !== "test"
  ) {
    throw new ConfigError([], ["HETU_HMAC_KEY: the development placeholder is not a key"]);
  }
  // The staff login's return address (#49): a production box without the
  // admin-app-url parameter would send a live one-time code to localhost.
  if (env.APP_ENV === "production" && !env.ADMIN_APP_URL.startsWith("https://")) {
    throw new ConfigError(
      ["ADMIN_APP_URL"],
      ["ADMIN_APP_URL: production needs the panel's https address (SSM admin-app-url)"],
    );
  }
  // A browser origin the production API answers is the panel's or the site's
  // https host; a developer's http://localhost belongs to staging only.
  if (env.APP_ENV === "production") {
    const plain = [...allowedOrigins(env)].filter((o) => !o.startsWith("https://"));
    if (plain.length > 0) {
      throw new ConfigError([], ["CORS_ALLOWED_ORIGINS: production allows https origins only"]);
    }
  }
  const rateLimit =
    env.RATE_LIMIT_PER_MINUTE ??
    (env.APP_ENV === "preview" ? RATE_LIMIT_DEFAULT.preview : RATE_LIMIT_DEFAULT.other);
  // A preview reads the whole /kuutti/staging/* prefix through the shared
  // instance role; what it must never hold in memory is dropped here, so a
  // preview process cannot reach the environment's own database even by
  // accident. The preview role from db-app-role.sh is the real boundary.
  // The same for photos (#48, ADR-005): staging's bucket and signing key
  // would make a preview a writer of staging's objects, refcounted against
  // the wrong database; a preview has no media and its photo routes answer 503.
  // And for the bank login (ADR-014 §1, docs/vendors/telia.md): a preview may
  // never use the real broker, and no mock bank is deployed beside it, so the
  // Telia client and both private keys stay out of its memory and its auth
  // routes answer 503. The HMAC key goes with them: with no login there is
  // nothing to derive.
  if (preview) {
    env.DB_APP_PASSWORD = undefined;
    env.MEDIA_URL_BASE = undefined;
    env.CLOUDFRONT_KEY_PAIR_ID = undefined;
    env.CLOUDFRONT_SIGNING_KEY = undefined;
    env.OIDC_ISSUER = undefined;
    env.OIDC_CLIENT_ID = undefined;
    env.OIDC_REDIRECT_URI = undefined;
    env.OIDC_ACR_VALUES = undefined;
    env.TELIA_SIGNING_KEY = undefined;
    env.TELIA_ENCRYPTION_KEY = undefined;
    env.HETU_HMAC_KEY = undefined;
  }
  const trustedProxy: TrustedProxy =
    env.TRUSTED_PROXY ??
    (env.APP_ENV === "development" || env.APP_ENV === "test" ? "none" : "traefik");
  return {
    ...env,
    RATE_LIMIT_PER_MINUTE: rateLimit,
    TRUSTED_PROXY: trustedProxy,
    databaseUrl: preview ? withDatabase(baseUrl, preview.database) : baseUrl,
    corsAllowedOrigins: allowedOrigins(env),
    ...(preview
      ? { preview: { ...preview, adminDatabaseUrl: withDatabase(baseUrl, "postgres") } }
      : {}),
  };
}

/**
 * A preview is a pull request number on APP_ENV=preview, nothing else: the
 * number names the database, and a staging or production process that
 * received one by mistake must not start against kuutti_pr_<n>.
 */
function previewConfig(
  env: z.infer<typeof Env>,
): Omit<PreviewConfig, "adminDatabaseUrl"> | undefined {
  if (env.PR_NUMBER === undefined) {
    if (env.APP_ENV === "preview") {
      throw new ConfigError(["PR_NUMBER"], ["PR_NUMBER: required when APP_ENV is preview"]);
    }
    return undefined;
  }
  if (env.APP_ENV !== "preview") {
    throw new ConfigError([], [`PR_NUMBER: only valid with APP_ENV=preview, not ${env.APP_ENV}`]);
  }
  return { prNumber: env.PR_NUMBER, database: `kuutti_pr_${env.PR_NUMBER}` };
}

/** Same host and options, another database; a URL that does not parse never reaches a log line. */
function withDatabase(url: string, database: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(["DATABASE_URL"], ["DATABASE_URL: not a URL"]);
  }
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * From the SSM-shaped parts. A preview connects as the preview role, never as
 * the environment's application role: the preview role owns kuutti_pr_<n> and
 * cannot connect to the environment's own database (#9).
 */
function composeDatabaseUrl(env: z.infer<typeof Env>, preview: boolean): string | undefined {
  const user = preview ? env.DB_PREVIEW_USER : env.DB_USER;
  const password = preview ? env.DB_PREVIEW_PASSWORD : env.DB_APP_PASSWORD;
  if (!env.DB_HOST || !env.DB_NAME || !user || !password) return undefined;
  // pg treats sslmode=require as encrypt-and-verify since 8.16; with the RDS
  // bundle that verification can succeed, and verify-full also pins the host.
  const ssl = env.DB_SSL_ROOT_CERT
    ? `sslmode=verify-full&sslrootcert=${encodeURIComponent(env.DB_SSL_ROOT_CERT)}`
    : "sslmode=require";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}?${ssl}`;
}

/**
 * Browser origins are refused unless named here (rule 8: no product web
 * surface). Development allows the Metro web target and the admin SPA's Vite
 * server; deployed environments name exactly the admin SPA, the waitlist site,
 * or the preview's own origin.
 */
function allowedOrigins(env: z.infer<typeof Env>): ReadonlySet<string> {
  if (env.CORS_ALLOWED_ORIGINS !== undefined) {
    return new Set(
      env.CORS_ALLOWED_ORIGINS.split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    );
  }
  return env.APP_ENV === "development" || env.APP_ENV === "test"
    ? new Set(["http://localhost:8081", "http://localhost:5173"])
    : new Set();
}

/** SSM parameters fill in what the process environment does not set. */
export async function loadConfig(
  raw: Record<string, string | undefined> = process.env,
): Promise<Config> {
  const appEnv = raw.APP_ENV ?? "development";
  const deployed = appEnv === "staging" || appEnv === "production" || appEnv === "preview";
  const prefix = raw.SSM_PARAMETER_PREFIX ?? (deployed ? ssmPrefix(appEnv) : undefined);
  const fromSsm = prefix ? await loadSsmParameters(prefix) : {};
  return parseConfig({ ...fromSsm, ...raw });
}

/**
 * Parameter prefix for a deployed environment. The infrastructure names its
 * environments staging and prod (#7), so production reads /kuutti/prod/;
 * previews run on the staging instance and read staging parameters (#9).
 */
export function ssmPrefix(appEnv: string): string {
  const env = appEnv === "preview" ? "staging" : appEnv === "production" ? "prod" : appEnv;
  return `/kuutti/${env}/`;
}
