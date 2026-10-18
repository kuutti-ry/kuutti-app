import { clearSession, saveSession } from "@/lib/session";
import { FakeXhr, partsOf } from "@/test/xhr";
import { fetchMessages, sendPhoto } from "./client";
import { messageWithKnownDescription } from "./known";

// The chat's client for a photo (#350): the send through the media slice's
// upload, its multipart parts and its route; its answers and the pages read
// with a description key this build cannot say left out, never failing.

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
