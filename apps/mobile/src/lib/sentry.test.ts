import { sentryEnvironment, sentryOptions, stripBreadcrumb, stripUser } from "./sentry";

describe("sentry options", () => {
  const on = sentryOptions({ dsn: "https://k@o1.ingest.de.sentry.io/2", channel: "staging" });

  it("is off without a DSN", () => {
    expect(sentryOptions({ dsn: undefined, channel: null }).enabled).toBe(false);
    expect(sentryOptions({ dsn: "", channel: null }).enabled).toBe(false);
  });

  it("sends no PII, no traces, no replays, no screenshots, no sessions", () => {
    expect(on.enabled).toBe(true);
    expect(on.sendDefaultPii).toBe(false);
    expect(on.tracesSampleRate).toBe(0);
    expect(on.replaysSessionSampleRate).toBe(0);
    expect(on.replaysOnErrorSampleRate).toBe(0);
    expect(on.attachScreenshot).toBe(false);
    expect(on.attachViewHierarchy).toBe(false);
    expect(on.enableAutoSessionTracking).toBe(false);
  });

  it("drops the replay and feedback integrations from the defaults", () => {
    const filter = on.integrations;
    if (typeof filter !== "function") throw new Error("integrations must be a filter function");
    const names = filter([
      { name: "MobileReplay" },
      { name: "Feedback" },
      { name: "ReactNativeErrorHandlers" },
      { name: "NativeLinkedErrors" },
    ] as never[]).map((i) => i.name);
    expect(names).toEqual(["ReactNativeErrorHandlers", "NativeLinkedErrors"]);
  });

  it("sends every event without a user: the SDK's per-install id is a device identifier", () => {
    const send = on.beforeSend;
    if (typeof send !== "function") throw new Error("beforeSend must be set");
    const event = { message: "x", user: { id: "4025CEE9-1C6D-41D0-A854-6B3CD8FC2652" } };
    const sent = send(event as never, {}) as { user?: unknown };
    expect(sent.user).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain("4025CEE9");
    expect(stripUser({ user: { id: "a" }, other: 1 })).toEqual({ user: undefined, other: 1 });
  });

  it("maps the update channel to the environment", () => {
    expect(sentryEnvironment(null)).toBe("development");
    expect(sentryEnvironment("staging")).toBe("staging");
    expect(sentryEnvironment("pr-42")).toBe("preview");
    expect(sentryEnvironment("production")).toBe("production");
  });

  it("keeps route names and http status on breadcrumbs, nothing else", () => {
    const nav = stripBreadcrumb({
      category: "navigation",
      data: { from: "/pond", to: "/chat/[id]", params: { id: "chat-7", email: "a@b.fi" } },
    });
    expect(nav.data).toEqual({ from: "/pond", to: "/chat/[id]" });
    const http = stripBreadcrumb({
      category: "http",
      data: { method: "GET", status_code: 500, url: "https://api/x?hetu=010190-123A" },
    });
    expect(http.data).toEqual({ method: "GET", status_code: 500 });
    expect(JSON.stringify([nav, http])).not.toMatch(/a@b\.fi|010190-123A|chat-7/);
  });

  it("strips xhr and fetch breadcrumbs the same way, and one without data keeps nothing", () => {
    for (const category of ["xhr", "fetch"]) {
      expect(
        stripBreadcrumb({
          category,
          data: { method: "POST", status_code: 201, url: "https://api/photos?x=1", body: "secret" },
        }).data,
      ).toEqual({ method: "POST", status_code: 201 });
    }
    expect(stripBreadcrumb({ category: "fetch" }).data).toEqual({
      method: undefined,
      status_code: undefined,
    });
  });

  it("leaves a navigation breadcrumb without data, and any other category, as it was", () => {
    const bare = { category: "navigation", message: "opened" };
    expect(stripBreadcrumb(bare)).toBe(bare);
    const logged = { category: "console", message: "warn", data: { arguments: ["x"] } };
    expect(stripBreadcrumb(logged)).toBe(logged);
  });
});
