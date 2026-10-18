import { serve } from "@hono/node-server";
import { boot } from "./boot.ts";
import { createSocketServer, startChatListener } from "./chat/index.ts";
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
  const { app, pool, jobs, live } = await boot({ config, logger });
  scheduleNightly(jobs, logger);
  // The chat's sockets (#349): upgrades on the same server, a frame bounded
  // before it is parsed, and the committed changes from Postgres's channel.
  const wss = createSocketServer();
  const listener = startChatListener({ pool, logger, live });

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
      websocket: { server: wss },
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
    // The listener holds one of the pool's connections: let it go first, or the pool's end waits for it.
    flushSentry()
      .then(() => listener.stop())
      .then(() => pool.end())
      .finally(() => process.exit(1));
  });

  // Drain in-flight requests within 10 s so a redeploy drops nothing. An
  // open socket would hold the server open: each is told `restarting` and
  // closed, so the phones reconnect to the next process and resume, and one
  // that does not finish its closing handshake in a second is cut.
  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    live.closeAll(1012, "restarting");
    setTimeout(() => {
      for (const client of wss.clients) client.terminate();
    }, 1_000).unref();
    server.close(() => {
      listener
        .stop()
        .then(() => pool.end())
        .finally(() => process.exit(0));
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
