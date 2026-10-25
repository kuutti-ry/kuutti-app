import { describe, expect, it } from "vitest";
import { captureLogger } from "../test/harness.ts";
import { serializeError } from "./logger.ts";
import {
  expoPusher,
  logPusher,
  MIXED_PROJECTS,
  PUSHES_PER_REQUEST,
  PushFailed,
  type PushMessage,
  pusherFor,
} from "./push.ts";

// The Expo seam of #102 (ADR-055 §8): Expo's push service through a fetch
// that answers without the network, the development log, and the choice
// between them and none. Whom a push goes to is notifications/push.test.ts's.

const SEND = "https://exp.host/--/api/v2/push/send";
const RECEIPTS = "https://exp.host/--/api/v2/push/getReceipts";

/** The nth device's push, as notifications/push.ts words a message's: its kind alone. */
function pushTo(n: number): PushMessage {
  return {
    to: `ExponentPushToken[lib-push-device-${n}]`,
    body: "You have a new message",
    data: { kind: "message" },
    collapseId: "message",
    tag: "message",
    channelId: "default",
    priority: "high",
    sound: "default",
    ttl: 3600,
  };
}
const pushes = (count: number) => Array.from({ length: count }, (_, i) => pushTo(i + 1));

type Call = { url: string; init: RequestInit; headers: Headers; body: unknown };

/** A fetch that records each request and answers with what the test gives it. */
function fakeFetch(answer: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      init: init ?? {},
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    };
    calls.push(call);
    return answer(call, calls.length - 1);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Expo's answer to a send: a ticket per push, each taken with an id of its own. */
const taken = (call: Call) =>
  json(200, {
    data: (call.body as PushMessage[]).map((message) => ({
      status: "ok",
      id: `receipt-of-${message.to}`,
    })),
  });

/** What a send threw, once the pusher has made it its own error. */
async function failureOf(promise: Promise<unknown>): Promise<PushFailed> {
  const failure = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(PushFailed);
  return failure as PushFailed;
}

/** Nothing a failure carries, however it is printed, names a device. */
function expectNoToken(failure: PushFailed, tokens: readonly string[]) {
  const printed = [
    failure.message,
    String(failure),
    failure.stack ?? "",
    failure.reason,
    JSON.stringify(failure),
    JSON.stringify({ ...failure }),
  ].join("\n");
  for (const token of tokens) {
    expect(printed).not.toContain(token);
    expect(printed).not.toContain(token.slice("ExponentPushToken[".length, -1));
  }
  expect(printed).not.toMatch(/Expo(nent)?PushToken/);
}

describe("Expo's push service (ADR-055 §8)", () => {
  it("posts the pushes to Expo's send as JSON, unauthenticated without an access token", async () => {
    const { fetchImpl, calls } = fakeFetch(taken);
    const sent = pushes(2);
    const tickets = await expoPusher(fetchImpl).send(sent);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(SEND);
    expect(call?.init.method).toBe("POST");
    expect(call?.headers.get("accept")).toBe("application/json");
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.headers.has("authorization")).toBe(false);
    // The body is exactly the array handed in.
    expect(call?.body).toEqual(sent);
    expect(String(call?.init.body)).toBe(JSON.stringify(sent));
    // Cut at five seconds, not yet.
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(call?.init.signal?.aborted).toBe(false);
    expect(tickets).toEqual([
      { status: "ok", id: `receipt-of-${sent[0]?.to}` },
      { status: "ok", id: `receipt-of-${sent[1]?.to}` },
    ]);
  });

  it("with an access token, says it as a bearer for EAS's enhanced push security", async () => {
    const { fetchImpl, calls } = fakeFetch((call) =>
      call.url === SEND ? taken(call) : json(200, { data: { "r-1": { status: "ok" } } }),
    );
    await expoPusher(fetchImpl, { accessToken: "expo-access-test" }).send(pushes(1));
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer expo-access-test");
    await expoPusher(fetchImpl, { accessToken: "expo-access-test" }).receipts(["r-1"]);
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer expo-access-test");
  });

  it("sends 250 pushes as three requests of 100, 100 and 50, and answers the tickets in order", async () => {
    const { fetchImpl, calls } = fakeFetch(taken);
    const sent = pushes(250);
    const tickets = await expoPusher(fetchImpl).send(sent);
    expect(PUSHES_PER_REQUEST).toBe(100);
    expect(calls.map((call) => (call.body as unknown[]).length)).toEqual([100, 100, 50]);
    expect(calls.flatMap((call) => call.body as PushMessage[])).toEqual(sent);
    expect(tickets).toEqual(
      sent.map((message) => ({ status: "ok", id: `receipt-of-${message.to}` })),
    );
  });

  it.each([
    [0, 0],
    [1, 1],
    [100, 1],
    [101, 2],
    [200, 2],
  ])("sends %i pushes in %i requests", async (count, requests) => {
    const { fetchImpl, calls } = fakeFetch(taken);
    expect(await expoPusher(fetchImpl).send(pushes(count))).toHaveLength(count);
    expect(calls).toHaveLength(requests);
  });

  it("maps an error ticket with its code, and one without details to no code, carrying nothing else", async () => {
    const sent = pushes(3);
    const { fetchImpl } = fakeFetch(() =>
      json(200, {
        data: [
          { status: "ok", id: "r-1" },
          {
            status: "error",
            // Expo names the device in its words and its details: neither is kept.
            message: `"${sent[1]?.to}" is not a registered push notification recipient`,
            details: { error: "DeviceNotRegistered", expoPushToken: sent[1]?.to },
          },
          { status: "error", message: "Something went wrong" },
        ],
      }),
    );
    const tickets = await expoPusher(fetchImpl).send(sent);
    expect(tickets).toStrictEqual([
      { status: "ok", id: "r-1" },
      { status: "error", error: "DeviceNotRegistered" },
      { status: "error", error: null },
    ]);
    expect(JSON.stringify(tickets)).not.toContain("ExponentPushToken");
  });

  it.each<[string, (call: Call) => Response | Promise<Response>, string, number | undefined]>([
    ["a ticket count that does not match", () => json(200, { data: [] }), "unexpected_answer", 200],
    [
      "a ticket of an unknown status",
      (call) =>
        json(200, { data: (call.body as unknown[]).map(() => ({ status: "maybe", id: "r" })) }),
      "unexpected_answer",
      200,
    ],
    [
      "a body that is no JSON",
      () => new Response("<html>bad gateway</html>", { status: 200 }),
      "unexpected_answer",
      200,
    ],
    [
      "an HTTP 429 with Expo's code",
      () =>
        json(429, {
          errors: [{ code: "TOO_MANY_REQUESTS", message: "Rate limit exceeded" }],
        }),
      "TOO_MANY_REQUESTS",
      429,
    ],
    [
      "an HTTP 401 once enhanced security is on",
      () => json(401, { errors: [{ code: "UNAUTHORIZED", message: "no access token" }] }),
      "UNAUTHORIZED",
      401,
    ],
    [
      "an HTTP 500 with no JSON",
      () => new Response("internal error", { status: 500 }),
      "refused",
      500,
    ],
    ["an HTTP 503 with JSON but no code", () => json(503, { data: [] }), "refused", 503],
    [
      "a 200 that refuses the whole request",
      (call) =>
        json(200, {
          errors: [
            {
              code: "PUSH_TOO_MANY_NOTIFICATIONS",
              message: `Too many for ${(call.body as PushMessage[])[0]?.to}`,
              details: { "@kuutti/other": [(call.body as PushMessage[])[0]?.to ?? ""] },
            },
          ],
        }),
      "PUSH_TOO_MANY_NOTIFICATIONS",
      200,
    ],
    [
      "tokens of several projects, with no details to say which",
      () => json(400, { errors: [{ code: MIXED_PROJECTS, message: "Separate them by project." }] }),
      MIXED_PROJECTS,
      400,
    ],
    [
      "a fetch that throws",
      () => Promise.reject(new TypeError(`fetch failed for ${pushTo(1).to}`)),
      "TypeError",
      undefined,
    ],
    [
      "a fetch cut by its timeout",
      () =>
        Promise.reject(
          new DOMException("The operation was aborted due to timeout", "TimeoutError"),
        ),
      "TimeoutError",
      undefined,
    ],
    ["a fetch that throws no error", () => Promise.reject("gone"), "unknown", undefined],
  ])(
    "%s throws PushFailed with its reason and status, and names no device",
    async (_, answer, reason, status) => {
      const { fetchImpl } = fakeFetch(answer);
      const sent = pushes(2);
      const failure = await failureOf(expoPusher(fetchImpl).send(sent));
      expect(failure.name).toBe("PushFailed");
      expect(failure.reason).toBe(reason);
      expect(failure.status).toBe(status);
      expect(failure.message).toBe(`push not sent: ${reason}`);
      expect(failure.cause).toBeUndefined();
      // Only a refusal for several projects that names them carries tokens.
      expect(failure.byProject).toBeUndefined();
      expectNoToken(
        failure,
        sent.map((message) => message.to),
      );
    },
  );

  it("a request refused for tokens of several projects carries each project's tokens as a property, and nothing it prints names one", async () => {
    const sent = pushes(3);
    const [first, second, third] = sent.map((message) => message.to);
    const { fetchImpl } = fakeFetch(() =>
      json(400, {
        errors: [
          {
            code: MIXED_PROJECTS,
            message: `All push notification messages in the same request must be for the same project: ${second}`,
            details: { "@kuutti-ry/kuutti": [first, third], "@someone/else": [second] },
            isTransient: false,
          },
        ],
      }),
    );
    const failure = await failureOf(expoPusher(fetchImpl).send(sent));
    expect([failure.reason, failure.status]).toEqual([MIXED_PROJECTS, 400]);
    expect(MIXED_PROJECTS).toBe("PUSH_TOO_MANY_EXPERIENCE_IDS");
    // By Expo's names of the projects, for the sender to keep its own.
    expect(failure.byProject).toEqual({
      "@kuutti-ry/kuutti": [first, third],
      "@someone/else": [second],
    });
    const printed = [failure.message, String(failure), failure.stack ?? "", failure.reason].join(
      "\n",
    );
    expect(printed).not.toMatch(/Expo(nent)?PushToken|lib-push-device/);
    // The tokens are no field JSON or the logger's error serializer would write.
    expect(Object.keys(failure)).not.toContain("byProject");
    expect(JSON.stringify(failure)).not.toMatch(/lib-push-device/);
    expect(JSON.stringify(serializeError(failure))).not.toMatch(/lib-push-device/);
  });

  it("a mixed-projects refusal whose details are of another shape keeps its code and names no tokens", async () => {
    const sent = pushes(2);
    for (const details of [["a list"], { "@someone/else": "not a list" }, "words", null]) {
      const { fetchImpl } = fakeFetch(() =>
        json(400, { errors: [{ code: MIXED_PROJECTS, message: "mixed", details }] }),
      );
      const failure = await failureOf(expoPusher(fetchImpl).send(sent));
      expect([failure.reason, failure.status, failure.byProject], JSON.stringify(details)).toEqual([
        MIXED_PROJECTS,
        400,
        undefined,
      ]);
    }
  });

  it("a refusal of another code keeps no tokens, whatever its details", async () => {
    const sent = pushes(1);
    const { fetchImpl } = fakeFetch(() =>
      json(400, {
        errors: [
          {
            code: "PUSH_TOO_MANY_NOTIFICATIONS",
            details: { "@kuutti-ry/kuutti": [sent[0]?.to ?? ""] },
          },
        ],
      }),
    );
    const failure = await failureOf(expoPusher(fetchImpl).send(sent));
    expect(failure.reason).toBe("PUSH_TOO_MANY_NOTIFICATIONS");
    expect(failure.byProject).toBeUndefined();
    expectNoToken(failure, [sent[0]?.to ?? ""]);
  });

  it("cuts a request Expo does not answer within its time, as a timeout", async () => {
    // A fetch that answers only when its signal says the time is up.
    const { fetchImpl } = fakeFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.init.signal?.addEventListener("abort", () => reject(call.init.signal?.reason));
        }),
    );
    const failure = await failureOf(expoPusher(fetchImpl, { timeoutMs: 1 }).send(pushes(1)));
    expect(failure.reason).toBe("TimeoutError");
    expect(failure.status).toBeUndefined();
  });

  it("stops at the first request refused, and sends nothing after it", async () => {
    const { fetchImpl, calls } = fakeFetch((call, index) =>
      index === 1 ? json(429, { errors: [{ code: "TOO_MANY_REQUESTS" }] }) : taken(call),
    );
    const failure = await failureOf(expoPusher(fetchImpl).send(pushes(250)));
    expect(failure.reason).toBe("TOO_MANY_REQUESTS");
    expect(calls).toHaveLength(2);
  });
});

describe("Expo's receipts (ADR-055 §8)", () => {
  it("reads 1500 receipts as 1000 and 500, and maps each, an id Expo has none for left out", async () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `r-${i}`);
    const { fetchImpl, calls } = fakeFetch((call) => {
      const asked = (call.body as { ids: string[] }).ids;
      return json(200, {
        data: Object.fromEntries(
          asked
            .filter((id) => id !== "r-3")
            .map((id) => [
              id,
              id === "r-1"
                ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }
                : id === "r-2"
                  ? { status: "error", message: "no details" }
                  : { status: "ok" },
            ]),
        ),
      });
    });
    const receipts = await expoPusher(fetchImpl).receipts(ids);
    expect(calls.map((call) => call.url)).toEqual([RECEIPTS, RECEIPTS]);
    expect(calls.map((call) => (call.body as { ids: string[] }).ids.length)).toEqual([1000, 500]);
    expect(calls.flatMap((call) => (call.body as { ids: string[] }).ids)).toEqual(ids);
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(receipts.size).toBe(1499);
    expect(receipts.get("r-0")).toStrictEqual({ status: "ok" });
    expect(receipts.get("r-1")).toStrictEqual({ status: "error", error: "DeviceNotRegistered" });
    expect(receipts.get("r-2")).toStrictEqual({ status: "error", error: null });
    expect(receipts.has("r-3")).toBe(false);
    expect(receipts.get("r-1499")).toStrictEqual({ status: "ok" });
  });

  it("asks nothing for no ids", async () => {
    const { fetchImpl, calls } = fakeFetch(taken);
    expect((await expoPusher(fetchImpl).receipts([])).size).toBe(0);
    expect(calls).toEqual([]);
  });

  it.each<[string, () => Response]>([
    ["an array where the receipts should be", () => json(200, { data: [{ status: "ok" }] })],
    ["a receipt of an unknown status", () => json(200, { data: { "r-1": { status: "lost" } } })],
    ["no data at all", () => json(200, {})],
  ])("a malformed answer, %s, throws PushFailed", async (_, answer) => {
    const { fetchImpl } = fakeFetch(answer);
    const failure = await failureOf(expoPusher(fetchImpl).receipts(["r-1"]));
    expect([failure.reason, failure.status]).toEqual(["unexpected_answer", 200]);
  });

  it("a refused read throws PushFailed with Expo's code", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json(400, { errors: [{ code: "PUSH_TOO_MANY_RECEIPTS", message: "too many" }] }),
    );
    const failure = await failureOf(expoPusher(fetchImpl).receipts(["r-1"]));
    expect([failure.reason, failure.status]).toEqual(["PUSH_TOO_MANY_RECEIPTS", 400]);
  });
});

describe("the development log of pushes (ADR-055 §8)", () => {
  it("writes the kind of each push and nothing else, sends nothing, and answers taken", async () => {
    const { logger, lines } = await captureLogger();
    const sent: PushMessage[] = [
      pushTo(1),
      {
        ...pushTo(2),
        body: "Sinulle on uusi mätsi",
        data: { kind: "match" },
        collapseId: "match",
        tag: "match",
      },
      {
        ...pushTo(3),
        body: "Today's round is ready",
        data: { kind: "round" },
        collapseId: "round",
        tag: "round",
        priority: "normal",
      },
    ];
    const tickets = await logPusher(logger).send(sent);
    expect(tickets).toEqual([
      { status: "ok", id: "log-0" },
      { status: "ok", id: "log-1" },
      { status: "ok", id: "log-2" },
    ]);
    const written = lines().filter((line) => line.msg === "push not sent: written here instead");
    expect(written.map((line) => line.push)).toEqual(["message", "match", "round"]);
    const raw = JSON.stringify(lines());
    for (const message of sent) {
      expect(raw).not.toContain(message.to);
      expect(raw).not.toContain(message.body);
    }
    expect((await logPusher(logger).receipts(["log-0", "log-1"])).size).toBe(0);
  });
});

describe("the pusher the configuration names (ADR-055 §8)", () => {
  it("is Expo's for expo, unauthenticated without an access token and a bearer with one", async () => {
    const { logger } = await captureLogger();
    const { fetchImpl, calls } = fakeFetch(taken);
    await pusherFor({ PUSH: "expo" }, logger, fetchImpl)?.send(pushes(1));
    await pusherFor(
      { PUSH: "expo", EXPO_ACCESS_TOKEN: "expo-access-test" },
      logger,
      fetchImpl,
    )?.send(pushes(1));
    expect(calls.map((call) => [call.url, call.headers.get("authorization")])).toEqual([
      [SEND, null],
      [SEND, "Bearer expo-access-test"],
    ]);
  });

  it("is the log for log, which fetches nothing", async () => {
    const { logger, lines } = await captureLogger();
    const { fetchImpl, calls } = fakeFetch(taken);
    const pusher = pusherFor(
      { PUSH: "log", EXPO_ACCESS_TOKEN: "expo-access-test" },
      logger,
      fetchImpl,
    );
    expect(await pusher?.send(pushes(1))).toEqual([{ status: "ok", id: "log-0" }]);
    expect(calls).toEqual([]);
    expect(lines().map((line) => line.msg)).toEqual(["push not sent: written here instead"]);
  });

  it("is none for off", async () => {
    const { logger } = await captureLogger();
    const { fetchImpl, calls } = fakeFetch(taken);
    expect(
      pusherFor({ PUSH: "off", EXPO_ACCESS_TOKEN: "expo-access-test" }, logger, fetchImpl),
    ).toBe(undefined);
    expect(calls).toEqual([]);
  });
});
