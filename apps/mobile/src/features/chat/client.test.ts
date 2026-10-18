import { clearSession, saveSession } from "@/lib/session";
import { FakeXhr, partsOf } from "@/test/xhr";
import {
  fetchContacts,
  fetchMessages,
  fetchSharedContacts,
  removeContact,
  saveContact,
  sendPhoto,
  shareContact,
  stopSharing,
} from "./client";
import { messageWithKnownDescription } from "./known";

// The chat's client for a photo (#350): the send through the media slice's
// upload, its multipart parts and its route; its answers and the pages read
// with a description key this build cannot say left out, never failing. The
// contacts' routes (#103): methods, paths, the value in the body only, the
// answers parsed, and each refusal's code.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const ID = "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a70";
const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const picked = {
  uri: "file:///roll/1.jpg#resized",
  width: 1600,
  height: 1067,
  mimeType: "image/jpeg",
};
const description = {
  people: 1,
  setting: "outdoors",
  scene: ["lake"],
  objects: ["dog"],
  smile: true,
  glasses: false,
  sunglasses: false,
  facialHair: false,
};
/** A description of a newer API: a scene and an object this build has no words for. */
const newer = { ...description, scene: ["lake", "volcano"], objects: ["dog", "beer"] };
const sent = (over: Record<string, unknown> = {}) => ({
  id: "00000000-0000-4000-8000-000000000002",
  seq: 2,
  side: "mine",
  kind: "photo",
  body: "Mökillä",
  createdAt: "2026-10-17T11:59:00.000Z",
  clientId: CLIENT_ID,
  photo: {
    photoId: "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01",
    blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
    width: 1600,
    height: 1067,
    description: newer,
    urls: {
      thumb: "https://media.test/m/thumb.webp?sig=s",
      full: "https://media.test/m/full.webp?sig=s",
      expiresAt: "2030-01-01T00:15:00.000Z",
    },
  },
  ...over,
});

beforeEach(async () => {
  FakeXhr.install();
  await clearSession();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("sending a photo", () => {
  it("posts the phone's id, the caption and the picture to the conversation's photo route, and reports progress", async () => {
    FakeXhr.answers = [{ status: 201, body: JSON.stringify(sent()), progress: [40, 100] }];
    const seen: number[] = [];
    const message = await sendPhoto(
      ID,
      { photo: picked, clientId: CLIENT_ID, caption: "  Mökillä  " },
      (fraction) => seen.push(fraction),
    );
    expect(seen).toEqual([0.4, 1]);
    expect(FakeXhr.sent[0]?.url).toBe(`http://localhost:3000/conversations/${ID}/photos`);
    expect(
      partsOf(FakeXhr.sent[0]).map((part) => [part.fieldName, part.string ?? part.uri]),
    ).toEqual([
      ["clientId", CLIENT_ID],
      ["caption", "Mökillä"],
      ["photo", picked.uri],
    ]);
    // The scene and the object this build cannot say are left out; the rest stands.
    expect(message.photo?.description).toEqual(description);
    expect(message.body).toBe("Mökillä");
  });

  it("sends no caption for blank words, and takes the message stored before (200) as sent", async () => {
    FakeXhr.answers = [{ status: 200, body: JSON.stringify(sent({ body: null })) }];
    const message = await sendPhoto(ID, { photo: picked, clientId: CLIENT_ID, caption: "   " });
    expect(partsOf(FakeXhr.sent[0]).map((part) => part.fieldName)).toEqual(["clientId", "photo"]);
    expect(message.body).toBeNull();
  });

  it("fails a refusal with the API's code, and an answer outside the contract", async () => {
    FakeXhr.answers = [
      {
        status: 400,
        body: JSON.stringify({
          error: { code: "photo_rejected_violence", message: "x", requestId: "r" },
        }),
      },
      { status: 201, body: JSON.stringify({ id: "not a message" }) },
    ];
    await expect(
      sendPhoto(ID, { photo: picked, clientId: CLIENT_ID, caption: "" }),
    ).rejects.toMatchObject({ status: 400, code: "photo_rejected_violence" });
    await expect(
      sendPhoto(ID, { photo: picked, clientId: CLIENT_ID, caption: "" }),
    ).rejects.toThrow();
  });
});

describe("reading a page with photos", () => {
  it("leaves out a description key this build cannot say, and still refuses a page outside the contract", async () => {
    globalThis.fetch = jest.fn(async () =>
      json({
        messages: [
          sent(),
          sent({ seq: 3, id: "00000000-0000-4000-8000-000000000003", photo: null }),
        ],
      }),
    ) as unknown as typeof fetch;
    const [first, second] = await fetchMessages(ID, { after: 1, limit: 2 });
    expect(first?.photo?.description).toEqual(description);
    expect(second?.photo).toBeNull();
    globalThis.fetch = jest.fn(async () => json({ messages: "none" })) as unknown as typeof fetch;
    await expect(fetchMessages(ID, {})).rejects.toThrow();
  });

  it("hands back anything that is not a message, and a message without a photo, as it is", () => {
    for (const value of [null, "text", 3, [sent()], { id: "x" }]) {
      expect(messageWithKnownDescription(value)).toBe(value);
    }
  });
});

describe("the contacts' routes (#103)", () => {
  type Seen = { method: string; path: string; body: unknown };
  /** Every request recorded, each answered in turn. */
  function answering(...answers: Response[]): Seen[] {
    const seen: Seen[] = [];
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const text = request.method === "GET" ? "" : await request.text();
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: text ? JSON.parse(text) : null,
      });
      return answers.shift() ?? json({ error: { code: "x", message: "x", requestId: "r" } }, 500);
    }) as unknown as typeof fetch;
    return seen;
  }
  const refusal = (code: string, status: number) =>
    json({ error: { code, message: "x", requestId: "r" } }, status);
  const AT = "2026-10-18T09:00:00.000Z";
  const detail = {
    id: ID,
    state: "open",
    closedHow: null,
    counterpart: { deleted: false, name: "Sanna", age: 31, thumb: null },
    lastMessage: null,
    unread: 0,
    limits: { maxLength: 30 },
    counterpartReadUpTo: 0,
    contacts: { mine: [{ kind: "instagram", value: "aino.k", shared: true }], theirs: [] },
  };

  it("reads the stored pieces, and refuses an answer outside the contract", async () => {
    const pieces = [
      { kind: "phone", value: "+358401234567", updatedAt: AT },
      { kind: "instagram", value: "aino.k", updatedAt: AT },
    ];
    const seen = answering(json({ contacts: pieces }), json({ contacts: [{ kind: "fax" }] }));
    expect(await fetchContacts()).toEqual(pieces);
    expect(seen).toEqual([{ method: "GET", path: "/contacts", body: null }]);
    await expect(fetchContacts()).rejects.toThrow();
  });

  it("keeps a piece with its value in the body, never in the path, and hands back its stored form", async () => {
    const seen = answering(json({ kind: "phone", value: "+358401234567", updatedAt: AT }));
    expect(await saveContact("phone", "040 123 4567")).toEqual({
      kind: "phone",
      value: "+358401234567",
      updatedAt: AT,
    });
    expect(seen).toEqual([
      { method: "PUT", path: "/contacts/phone", body: { value: "040 123 4567" } },
    ]);
  });

  it("removes a piece, alike when none was kept", async () => {
    const seen = answering(new Response(null, { status: 204 }));
    await expect(removeContact("telegram")).resolves.toBeUndefined();
    expect(seen).toEqual([{ method: "DELETE", path: "/contacts/telegram", body: null }]);
  });

  it("shares and stops sharing in a conversation, each answering the fresh view", async () => {
    const stopped = {
      ...detail,
      contacts: { mine: [{ ...detail.contacts.mine[0], shared: false }], theirs: [] },
    };
    const seen = answering(json(detail), json(stopped));
    expect((await shareContact(ID, "instagram")).contacts.mine[0]?.shared).toBe(true);
    expect((await stopSharing(ID, "instagram")).contacts.mine[0]?.shared).toBe(false);
    expect(seen).toEqual([
      { method: "POST", path: `/conversations/${ID}/contacts/instagram`, body: null },
      { method: "DELETE", path: `/conversations/${ID}/contacts/instagram`, body: null },
    ]);
  });

  it("reads what is shared in a conversation alone, and refuses an answer outside the contract", async () => {
    const shared = {
      mine: [{ kind: "phone", value: "+358401234567", shared: false }],
      theirs: [{ kind: "instagram", value: "ville.k" }],
    };
    const seen = answering(json(shared), json({ mine: [], theirs: [{ kind: "fax", value: "1" }] }));
    expect(await fetchSharedContacts(ID)).toEqual(shared);
    expect(seen).toEqual([{ method: "GET", path: `/conversations/${ID}/contacts`, body: null }]);
    await expect(fetchSharedContacts(ID)).rejects.toThrow();
  });

  it.each<[string, () => Promise<unknown>, Response, number, string]>([
    ["a read", () => fetchContacts(), refusal("rate_limited", 429), 429, "rate_limited"],
    [
      "a read of what is shared in a conversation gone",
      () => fetchSharedContacts(ID),
      refusal("not_found", 404),
      404,
      "not_found",
    ],
    [
      "a keep past the messages of a minute",
      () => saveContact("telegram", "aino_k"),
      refusal("message_budget_exceeded", 429),
      429,
      "message_budget_exceeded",
    ],
    [
      "a piece not of its kind",
      () => saveContact("instagram", "a..b"),
      refusal("contact_invalid", 400),
      400,
      "contact_invalid",
    ],
    [
      "a piece of an account deleted meanwhile",
      () => saveContact("phone", "0401234567"),
      refusal("not_found", 404),
      404,
      "not_found",
    ],
    [
      "a removal",
      () => removeContact("phone"),
      refusal("internal_error", 500),
      500,
      "internal_error",
    ],
    [
      "a share of a piece removed meanwhile",
      () => shareContact(ID, "phone"),
      refusal("contact_not_stored", 409),
      409,
      "contact_not_stored",
    ],
    [
      "a share too fast",
      () => shareContact(ID, "phone"),
      refusal("message_budget_exceeded", 429),
      429,
      "message_budget_exceeded",
    ],
    [
      "a stop in a conversation gone",
      () => stopSharing(ID, "phone"),
      refusal("not_found", 404),
      404,
      "not_found",
    ],
  ])("fails %s with the API's status and code", async (_what, call, answer, status, code) => {
    answering(answer);
    await expect(call()).rejects.toMatchObject({ status, code });
  });

  it("fails an answer without the error envelope with its status and no code", async () => {
    answering(new Response("upstream", { status: 502 }));
    await expect(stopSharing(ID, "phone")).rejects.toMatchObject({ status: 502, code: undefined });
  });
});
