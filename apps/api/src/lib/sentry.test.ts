import * as Sentry from "@sentry/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  exceptions: [] as unknown[],
  tags: {} as Record<string, string>,
}));
vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  flush: vi.fn(async () => true),
  captureException: vi.fn((error: unknown) => {
    captured.exceptions.push(error);
    return "event-id";
  }),
  withScope: vi.fn((fn: (scope: { setTag(k: string, v: string): void }) => void) =>
    fn({
      setTag(k, v) {
        captured.tags[k] = v;
      },
    }),
  ),
}));

import {
  collectNothing,
  flushSentry,
  initSentry,
  sentryOptions,
  sentryReporter,
  stripRequestData,
} from "./sentry.ts";

const base = { APP_ENV: "staging" as const, APP_VERSION: "1.2.3", GIT_COMMIT: "abc1234" };

describe("sentry options", () => {
  it("is off without a DSN and on with one, never with PII or tracing", () => {
    expect(sentryOptions({ ...base, SENTRY_DSN: undefined }).enabled).toBe(false);
    const on = sentryOptions({ ...base, SENTRY_DSN: "https://k@o1.ingest.de.sentry.io/2" });
    expect(on.enabled).toBe(true);
    expect(on.environment).toBe("staging");
    expect(on.release).toBe("kuutti-api@1.2.3+abc1234");
    expect(on.dataCollection).toBe(collectNothing);
    expect(on.includeLocalVariables).toBe(false);
    expect(on.enableRuntimeChannelInjection).toBe(false);
    expect(on.tracePropagationTargets).toEqual([]);
    expect(on.sampleRate).toBe(1);
    expect(on.tracesSampleRate).toBe(0);
    expect(on.beforeSend).toBe(stripRequestData);
  });

  it("strips request data, user details and breadcrumb payloads from every event", () => {
    const event = stripRequestData({
      type: undefined,
      request: {
        url: "https://api.example/x?hetu=010190-123A",
        headers: { cookie: "session=abc" },
        data: { message: "private words" },
      },
      user: { id: "acc-1", email: "a@b.fi", ip_address: "10.0.0.1" },
      breadcrumbs: [{ category: "http", data: { url: "https://x/?email=a@b.fi" } }],
    });
    expect(event.request).toBeUndefined();
    expect(event.user).toEqual({ id: "acc-1" });
    expect(event.breadcrumbs?.[0]?.data).toBeUndefined();
    expect(JSON.stringify(event)).not.toMatch(/010190-123A|a@b\.fi|private words|session=abc/);
  });

  it("strips the values of local variables from every stack frame, and extra", () => {
    const event = stripRequestData({
      type: undefined,
      extra: { __serialized__: { hetu: "010190-123A" } },
      exception: {
        values: [
          {
            type: "Error",
            value: "boom",
            stacktrace: {
              frames: [
                {
                  function: "callback",
                  lineno: 12,
                  vars: { hetu: "010190-123A", body: "private words" },
                },
                { function: "handler", lineno: 40 },
              ],
            },
          },
        ],
      },
    });
    const frames = event.exception?.values?.[0]?.stacktrace?.frames;
    expect(frames).toEqual([
      { function: "callback", lineno: 12 },
      { function: "handler", lineno: 40 },
    ]);
    expect(event.extra).toBeUndefined();
    expect(JSON.stringify(event)).not.toMatch(/010190-123A|private words/);
  });

  it("reports an exception with the request id and route as tags", () => {
    const error = new Error("boom");
    sentryReporter()(error, { requestId: "req-1", route: "/health" });
    expect(captured.exceptions).toEqual([error]);
    expect(captured.tags).toEqual({ requestId: "req-1", route: "/health" });
  });
});

describe("sentry at boot and exit", () => {
  beforeEach(() => {
    vi.mocked(Sentry.init).mockClear();
    vi.mocked(Sentry.flush).mockClear();
    captured.exceptions.length = 0;
    for (const key of Object.keys(captured.tags)) delete captured.tags[key];
  });

  it("initialises the SDK only when a DSN is configured, and says whether it did", () => {
    expect(initSentry({ ...base, SENTRY_DSN: undefined })).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
    expect(initSentry({ ...base, SENTRY_DSN: "https://k@o1.ingest.de.sentry.io/2" })).toBe(true);
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Sentry.init).mock.calls[0]?.[0]).toMatchObject({
      dsn: "https://k@o1.ingest.de.sentry.io/2",
      environment: "staging",
      dataCollection: collectNothing,
    });
  });

  it("names a release without an injected commit as unknown", () => {
    expect(sentryOptions({ ...base, GIT_COMMIT: undefined, SENTRY_DSN: undefined }).release).toBe(
      "kuutti-api@1.2.3+unknown",
    );
  });

  it("reports an error outside a route with the request id alone", () => {
    const error = new Error("self-test");
    sentryReporter()(error, { requestId: "self-test" });
    expect(captured.exceptions).toEqual([error]);
    expect(captured.tags).toEqual({ requestId: "self-test" });
  });

  it("gives queued events two seconds by default to leave, and a failing flush never stops the exit", async () => {
    await flushSentry();
    expect(Sentry.flush).toHaveBeenLastCalledWith(2000);
    await flushSentry(50);
    expect(Sentry.flush).toHaveBeenLastCalledWith(50);
    vi.mocked(Sentry.flush).mockRejectedValueOnce(new Error("transport down"));
    await expect(flushSentry()).resolves.toBeUndefined();
  });
});

describe("events with less to strip", () => {
  it("drops a user without an id altogether, rather than keeping an empty one", () => {
    const event = stripRequestData({
      type: undefined,
      user: { email: "a@b.fi", ip_address: "10.0.0.1" },
    });
    expect(event.user).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("a@b.fi");
  });

  it("leaves an event with no user, breadcrumbs or stack frames as it was, request data aside", () => {
    const event = stripRequestData({
      type: undefined,
      message: "boom",
      tags: { requestId: "req-1" },
      exception: { values: [{ type: "Error", value: "boom" }] },
    });
    expect(event).toEqual({
      type: undefined,
      message: "boom",
      tags: { requestId: "req-1" },
      exception: { values: [{ type: "Error", value: "boom" }] },
    });
  });
});
