import { describe, expect, it } from "vitest";
import {
  ChatMessage,
  ConversationDetail,
  Counterpart,
  type DaysBand,
  daysBand,
  type ElapsedBand,
  ExportedConversation,
  elapsedBand,
  MESSAGE_BODY_CEILING,
  MESSAGES_PAGE_DEFAULT,
  type MessageCountBand,
  type MessageLengthBand,
  MessagesQuery,
  messageCountBand,
  messageLength,
  messageLengthBand,
  ReadRequest,
  SendMessageRequest,
  SendPhotoRequest,
} from "./chat.ts";

// The chat's contracts (#348, ADR-031): what a send, a page and a read mark
// accept, and the research events' bands.

const CLIENT_ID = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";

describe("a message to send", () => {
  it("is trimmed, and refused empty, blank, over the ceiling, without an id or with an unknown key", () => {
    expect(SendMessageRequest.parse({ clientId: CLIENT_ID, body: "  Moi!  " })).toEqual({
      clientId: CLIENT_ID,
      body: "Moi!",
    });
    for (const body of ["", "   ", "\n\t "]) {
      expect(SendMessageRequest.safeParse({ clientId: CLIENT_ID, body }).success, body).toBe(false);
    }
    const ceiling = "x".repeat(MESSAGE_BODY_CEILING);
    expect(SendMessageRequest.safeParse({ clientId: CLIENT_ID, body: ceiling }).success).toBe(true);
    expect(SendMessageRequest.safeParse({ clientId: CLIENT_ID, body: `${ceiling}x` }).success).toBe(
      false,
    );
    expect(SendMessageRequest.safeParse({ body: "Moi" }).success).toBe(false);
    expect(SendMessageRequest.safeParse({ clientId: "nope", body: "Moi" }).success).toBe(false);
    expect(SendMessageRequest.safeParse({ clientId: CLIENT_ID, body: 7 }).success).toBe(false);
    expect(SendMessageRequest.safeParse({ clientId: CLIENT_ID, body: "Moi\u0000" }).success).toBe(
      false,
    );
    expect(
      SendMessageRequest.safeParse({ clientId: CLIENT_ID, body: "Moi", photoId: CLIENT_ID })
        .success,
    ).toBe(false);
  });

  it("counts characters as a person does: an emoji or a letter with its mark is one", () => {
    expect(messageLength("Moi")).toBe(3);
    expect(messageLength("😀😀")).toBe(2);
    expect(messageLength("äö")).toBe(2);
    expect(messageLength("")).toBe(0);
  });
});

describe("a page of messages", () => {
  it("reads the newest page by default, back from before, onward from after, never both", () => {
    expect(MessagesQuery.parse({})).toEqual({ limit: MESSAGES_PAGE_DEFAULT });
    expect(MessagesQuery.parse({ before: "40", limit: "10" })).toEqual({ before: 40, limit: 10 });
    expect(MessagesQuery.parse({ after: "0" })).toEqual({ after: 0, limit: MESSAGES_PAGE_DEFAULT });
    expect(MessagesQuery.safeParse({ before: "4", after: "2" }).success).toBe(false);
    for (const limit of ["0", "101", "1.5", "x"]) {
      expect(MessagesQuery.safeParse({ limit }).success, limit).toBe(false);
    }
    for (const seq of ["-1", "2147483648", "x"]) {
      expect(MessagesQuery.safeParse({ before: seq }).success, seq).toBe(false);
    }
    expect(MessagesQuery.safeParse({ since: "1" }).success).toBe(false);
  });
});

describe("a read mark", () => {
  it("is a whole sequence from zero, and nothing else", () => {
    expect(ReadRequest.parse({ upTo: 0 })).toEqual({ upTo: 0 });
    expect(ReadRequest.parse({ upTo: 12 })).toEqual({ upTo: 12 });
    for (const upTo of [-1, 1.5, "3", null, 2_147_483_648]) {
      expect(ReadRequest.safeParse({ upTo }).success, String(upTo)).toBe(false);
    }
    expect(ReadRequest.safeParse({ upTo: 1, seq: 2 }).success).toBe(false);
  });
});

describe("the counterpart and the conversation", () => {
  it("is a person with a name, an age and maybe a thumb, or nobody", () => {
    expect(Counterpart.parse({ deleted: true })).toEqual({ deleted: true });
    expect(
      Counterpart.parse({ deleted: false, name: "Sanna", age: 31, thumb: null }),
    ).toMatchObject({ name: "Sanna" });
    expect(
      Counterpart.safeParse({ deleted: false, name: "Sanna", age: 17, thumb: null }).success,
    ).toBe(false);
    expect(Counterpart.safeParse({ name: "Sanna", age: 31, thumb: null }).success).toBe(false);
  });

  it("gives the composer its limit and the read mark of the other side", () => {
    const detail = ConversationDetail.parse({
      id: CLIENT_ID,
      state: "closed",
      closedHow: "erasure",
      counterpart: { deleted: true },
      lastMessage: null,
      unread: 0,
      limits: { maxLength: 2000 },
      counterpartReadUpTo: 4,
      contacts: { mine: [], theirs: [] },
    });
    expect(detail.limits.maxLength).toBe(2000);
    // A block or a sanction never reaches a client as such (ADR-030 §6, ADR-024 §6).
    for (const closedHow of ["block", "sanction"]) {
      expect(ConversationDetail.safeParse({ ...detail, closedHow }).success, closedHow).toBe(false);
    }
  });

  it("exports the person's own words and photos, and the other's as a kind, a time and a length only", () => {
    const at = "2026-10-17T10:00:00.000Z";
    const exported = {
      openedAt: at,
      state: "open",
      closedHow: null,
      mine: [
        { at, kind: "text", body: "Moi", photo: null },
        {
          at,
          kind: "photo",
          body: "",
          photo: {
            file: "photos/6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b.webp",
            review: { decision: "queued", reason: null, decidedByStaff: false, decidedAt: null },
            description: null,
            descriptionText: null,
          },
        },
      ],
      shares: [{ kind: "telegram", sharedAt: at, endedAt: null, endedHow: null }],
      theirs: [
        { at, kind: "text", length: 12 },
        { at, kind: "photo", length: 0 },
      ],
    };
    expect(ExportedConversation.safeParse(exported).success).toBe(true);
    // A sent photo is an entry, as a profile photo's is, not a bare path.
    expect(
      ExportedConversation.safeParse({
        ...exported,
        mine: [{ at, kind: "photo", body: "", photo: "photos/x.webp" }],
      }).success,
    ).toBe(false);
    // Never the other's words.
    expect(
      ExportedConversation.parse({
        ...exported,
        theirs: [{ at, kind: "text", length: 3, body: "Moi" }],
      }).theirs,
    ).toEqual([{ at, kind: "text", length: 3 }]);
  });
});

describe("the research events' bands", () => {
  it("band a length at each edge", () => {
    const cases: Array<[number, MessageLengthBand]> = [
      // A photo sent without a caption (#350); a text is never empty.
      [0, "0"],
      [1, "1-20"],
      [20, "1-20"],
      [21, "21-80"],
      [80, "21-80"],
      [81, "81-280"],
      [280, "81-280"],
      [281, "281-1000"],
      [1000, "281-1000"],
      [1001, "1001+"],
      [2000, "1001+"],
    ];
    for (const [length, band] of cases)
      expect(messageLengthBand(length), String(length)).toBe(band);
  });

  it("band a wait at each edge", () => {
    const MINUTE = 60_000;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;
    const cases: Array<[number, ElapsedBand]> = [
      [0, "under_1m"],
      [MINUTE - 1, "under_1m"],
      [MINUTE, "1m_1h"],
      [HOUR - 1, "1m_1h"],
      [HOUR, "1h_1d"],
      [DAY - 1, "1h_1d"],
      [DAY, "1d_7d"],
      [7 * DAY - 1, "1d_7d"],
      [7 * DAY, "7d_plus"],
      [400 * DAY, "7d_plus"],
    ];
    for (const [ms, band] of cases) expect(elapsedBand(ms), String(ms)).toBe(band);
  });

  it("band a count of messages and a number of days at each edge", () => {
    const counts: Array<[number, MessageCountBand]> = [
      [0, "0"],
      [1, "1-5"],
      [5, "1-5"],
      [6, "6-20"],
      [20, "6-20"],
      [21, "21-100"],
      [100, "21-100"],
      [101, "101+"],
    ];
    for (const [n, band] of counts) expect(messageCountBand(n), String(n)).toBe(band);
    const days: Array<[number, DaysBand]> = [
      [0, "0-6"],
      [6, "0-6"],
      [7, "7-13"],
      [13, "7-13"],
      [14, "14-29"],
      [29, "14-29"],
      [30, "30-89"],
      [89, "30-89"],
      [90, "90+"],
    ];
    for (const [n, band] of days) expect(daysBand(n), String(n)).toBe(band);
  });
});

describe("a photo in a message (#350)", () => {
  const CLIENT = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
  // Node's File, which this package's types do not declare (it imports nothing but zod).
  const NodeFile = (
    globalThis as unknown as {
      File: new (parts: Uint8Array[], name: string, options: { type: string }) => unknown;
    }
  ).File;
  const picture = (type = "image/jpeg") =>
    new NodeFile([new Uint8Array([1, 2, 3])], "p.jpg", { type });

  it("sends a picture with the phone's id and an optional caption, trimmed", () => {
    const sent = SendPhotoRequest.parse({ photo: picture(), clientId: CLIENT, caption: "  Moi  " });
    expect(sent.caption).toBe("Moi");
    expect(SendPhotoRequest.parse({ photo: picture(), clientId: CLIENT }).caption).toBeUndefined();
  });

  it("refuses no picture, another type, a malformed id, a caption with NUL or past the ceiling, an unknown field", () => {
    const refused = [
      { clientId: CLIENT },
      { photo: picture("image/gif"), clientId: CLIENT },
      { photo: picture(), clientId: "nope" },
      { photo: picture(), clientId: CLIENT, caption: "a\u0000b" },
      { photo: picture(), clientId: CLIENT, caption: "x".repeat(MESSAGE_BODY_CEILING + 1) },
      { photo: picture(), clientId: CLIENT, note: "x" },
    ];
    for (const input of refused) expect(SendPhotoRequest.safeParse(input).success).toBe(false);
  });

  it("carries a photo message's photo, with or without its URLs, and none on a text or a removed photo", () => {
    const base = {
      id: CLIENT,
      seq: 1,
      side: "theirs",
      kind: "photo",
      body: null,
      createdAt: "2026-10-17T10:00:00.000Z",
      clientId: null,
    };
    const photo = {
      photoId: CLIENT,
      blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
      width: 1600,
      height: 1200,
      description: null,
    };
    const urls = {
      thumb: "https://api.test/media/x/thumb.webp",
      full: "https://api.test/media/x/full.webp",
      expiresAt: "2026-10-17T10:15:00.000Z",
    };
    expect(ChatMessage.safeParse({ ...base, photo: { ...photo, urls } }).success).toBe(true);
    expect(ChatMessage.safeParse({ ...base, photo: { ...photo, urls: null } }).success).toBe(true);
    expect(ChatMessage.safeParse({ ...base, photo: null }).success).toBe(true);
    expect(ChatMessage.safeParse(base).success).toBe(false);
    expect(
      ChatMessage.safeParse({ ...base, photo: { ...photo, width: 0, urls: null } }).success,
    ).toBe(false);
  });
});
