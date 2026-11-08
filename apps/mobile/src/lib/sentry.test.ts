import {
  sentryEnvironment,
  sentryOptions,
  stripBreadcrumb,
  stripSupportView,
  stripUser,
} from "./sentry";

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

  describe("the support page, which no report names (#510)", () => {
    it.each([
      [
        "going there",
        {
          category: "navigation",
          message: "Navigation to settings/support",
          data: { from: "settings/index", to: "settings/support" },
        },
      ],
      [
        "coming back",
        {
          category: "navigation",
          message: "Navigation to settings/index",
          data: { from: "settings/support", to: "settings/index" },
        },
      ],
      [
        "by the full path",
        {
          category: "navigation",
          message: "Navigation to /settings/support",
          data: { to: "/settings/support" },
        },
      ],
      [
        "the press that leads there",
        {
          category: "navigation.dispatch",
          message: "Dispatched PUSH to settings/support",
          data: { action_type: "PUSH", to: "settings/support" },
        },
      ],
      [
        "a crumb with its route in the message alone",
        { category: "navigation.dispatch", message: "Dispatched PUSH to settings/support" },
      ],
    ])("drops the crumb of %s", (_case, crumb) => {
      expect(stripBreadcrumb(crumb)).toBeNull();
    });

    it("keeps the crumbs of other routes, and a crumb of another category that says the words", () => {
      const licences = {
        category: "navigation",
        message: "Navigation to settings/licenses",
        data: { from: "settings/index", to: "settings/licenses" },
      };
      expect(stripBreadcrumb(licences)).toEqual(licences);
      const log = { category: "console", message: "settings/support" };
      expect(stripBreadcrumb(log)).toEqual(log);
    });

    it("sends an event from the page without the view's name, the rest of its app context kept", () => {
      const send = on.beforeSend;
      if (typeof send !== "function") throw new Error("beforeSend must be set");
      const event = {
        message: "x",
        contexts: { app: { view_names: ["settings/support"], app_version: "0.81.0" } },
      };
      const sent = send(event as never, {}) as { contexts: { app: Record<string, unknown> } };
      expect(sent.contexts.app).toEqual({ app_version: "0.81.0" });
      expect(JSON.stringify(sent)).not.toContain("settings/support");
    });

    it.each([
      ["another view", { contexts: { app: { view_names: ["settings/index"] } } }],
      ["an app context with no view", { contexts: { app: { app_version: "0.81.0" } } }],
      ["no contexts", {}],
    ])("leaves an event with %s as it was", (_case, event) => {
      expect(stripSupportView(event)).toEqual(event);
    });
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
    expect(nav?.data).toEqual({ from: "/pond", to: "/chat/[id]" });
    const http = stripBreadcrumb({
      category: "http",
      data: { method: "GET", status_code: 500, url: "https://api/x?hetu=010190-123A" },
    });
    expect(http?.data).toEqual({ method: "GET", status_code: 500 });
    expect(JSON.stringify([nav, http])).not.toMatch(/a@b\.fi|010190-123A|chat-7/);
  });

  it("strips xhr and fetch breadcrumbs the same way, and one without data keeps nothing", () => {
    for (const category of ["xhr", "fetch"]) {
      expect(
        stripBreadcrumb({
          category,
          data: { method: "POST", status_code: 201, url: "https://api/photos?x=1", body: "secret" },
        })?.data,
      ).toEqual({ method: "POST", status_code: 201 });
    }
    expect(stripBreadcrumb({ category: "fetch" })?.data).toEqual({
      method: undefined,
      status_code: undefined,
    });
  });

  it("keeps a touch's component names and drops what it read there: a label, a message, a shared contact (#103)", () => {
    const path = [
      { name: "Text", label: "Sanna shares Instagram: ville.k" },
      { name: "SharedContacts", file: "SharedContacts.tsx", label: "Instagram: ville.k" },
      { name: "View", element: "RCTView", label: "Sanna, 31 Moi, nähdään huomenna" },
    ];
    const touch = stripBreadcrumb({
      category: "touch",
      type: "user",
      level: "info",
      message: "Touch event within element: Sanna shares Instagram: ville.k",
      data: { path },
    });
    expect(touch).toEqual({
      category: "touch",
      type: "user",
      level: "info",
      message: "Text",
      data: {
        path: [
          { name: "Text", element: undefined, file: undefined },
          { name: "SharedContacts", element: undefined, file: "SharedContacts.tsx" },
          { name: "View", element: "RCTView", file: undefined },
        ],
      },
    });
    const rage = stripBreadcrumb({
      category: "ui.multiClick",
      message: "Sanna shares Instagram: ville.k",
      data: {
        clickCount: 3,
        route: "/chats/3f9a2c1e",
        node: { attributes: { "sentry-label": "ville.k" } },
        path,
      },
    });
    expect(rage?.message).toBe("Text");
    expect(rage?.data).toMatchObject({ clickCount: 3 });
    expect(JSON.stringify([touch, rage])).not.toMatch(/ville|Sanna|nähdään|3f9a2c1e/);
    // A touch without a path, or with a root the SDK could not name, says nothing.
    expect(
      stripBreadcrumb({ category: "touch", message: "Touch event within element: x" }),
    ).toEqual({
      category: "touch",
      message: undefined,
      data: { path: [] },
    });
    expect(stripBreadcrumb({ category: "touch", data: { path: [{ label: "x" }] } })?.message).toBe(
      undefined,
    );
  });

  it("leaves a navigation breadcrumb without data, and any other category, as it was", () => {
    const bare = { category: "navigation", message: "opened" };
    expect(stripBreadcrumb(bare)).toBe(bare);
    const logged = { category: "console", message: "warn", data: { arguments: ["x"] } };
    expect(stripBreadcrumb(logged)).toBe(logged);
  });
});
