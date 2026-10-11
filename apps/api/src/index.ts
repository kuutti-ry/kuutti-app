import { serve } from "@hono/node-server";
import { boot } from "./boot.ts";
import { scheduleNightly } from "./jobs/nightly.ts";
import { type Config, ConfigError, loadConfig } from "./lib/config.ts";
import { createLogger } from "./lib/logger.ts";
import { flushSentry } from "./lib/sentry.ts";
import { buildInfo } from "./lib/version.ts";

async function main(): Promise<void> {
  let config: Config;
  try {
    config = await loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      const missing = error.missing.length > 0 ? error.missing.join(", ") : "none";
      console.error(
        `Configuration invalid. Missing keys: ${missing}\n  ${error.issues.join("\n  ")}`,
      );
      process.exit(1);
    }
    throw error;
  }

  const logger = await createLogger({
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === "development",
  });
  const info = buildInfo(config);

  // Everything from the configuration to the app, the pool and the jobs is
  // boot.ts, where the tests run it; this file is the process around it.
  const { app, pool, jobs } = await boot({ config, logger });
  scheduleNightly(jobs, logger);

  const server = serve(
    {
      fetch: app.fetch,
      port: config.PORT,
      hostname: "0.0.0.0",
      // Idle connections stay open past what a client or proxy keeps them for (#225).
      // Node closes them after 5 s; Android's OkHttp checks a pooled connection for a
      // POST only once it has been idle 10 s, so an upload sent 5 to 10 s after the
      // previous call went out on a closed socket and failed before reaching us. The
      // headers timeout stays above it, as Node's documentation asks.
      serverOptions: { keepAliveTimeout: 65_000, headersTimeout: 66_000 },
    },
    (address) => {
      logger.info(
        { port: address.port, appEnv: config.APP_ENV, version: info.version, commit: info.commit },
        "API listening",
      );
    },
  );

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      logger.fatal(
        { port: config.PORT },
        `port ${config.PORT} is already in use: another API is running, stop it or set PORT`,
      );
    } else {
      logger.fatal({ err: error }, "server error");
    }
    flushSentry()
      .then(() => pool.end())
      .finally(() => process.exit(1));
  });

  // Drain in-flight requests within 10 s so a redeploy drops nothing.
  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
