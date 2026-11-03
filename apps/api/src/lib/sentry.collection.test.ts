import * as Sentry from "@sentry/node";
import { afterAll, describe, expect, it } from "vitest";
import { sentryOptions } from "./sentry.ts";

/**
 * The real SDK, not a mock: what it resolves from our options is what it
 * would collect. The default integrations are left out and nothing is sent;
 * the transport only keeps what it is handed, which has to be nothing.
 */
const sent: unknown[] = [];
const client = Sentry.init({
  ...sentryOptions({
    SENTRY_DSN: "https://k@o1.ingest.de.sentry.io/2",
    APP_ENV: "test",
    APP_VERSION: "0.0.0",
    GIT_COMMIT: "abc1234",
  }),
  defaultIntegrations: false,
  enableOpenTelemetrySetup: false,
  transport: () => ({
    send: async (envelope) => {
      sent.push(envelope);
      return {};
    },
    flush: async () => true,
  }),
});

afterAll(async () => {
  await Sentry.close(0);
});

describe("what the SDK collects with our options", () => {
  it("has every category of collected data switched off", () => {
    expect(client).toBeDefined();
    const { frameContextLines, ...collected } = client?.getDataCollectionOptions() ?? {};
    // Lines of our own published source around a frame: code, not data.
    expect(frameContextLines).toBeTypeOf("number");
    expect(collected).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    });
  });

  it("does not attach local variables, inject into modules or add trace headers", () => {
    const options = client?.getOptions();
    expect(options?.includeLocalVariables).toBe(false);
    expect(options?.enableRuntimeChannelInjection).toBe(false);
    expect(options?.tracePropagationTargets).toEqual([]);
  });

  it("sends nothing by being initialised", async () => {
    await Sentry.flush(0);
    expect(sent).toEqual([]);
  });
});
