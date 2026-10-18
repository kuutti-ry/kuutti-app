import { describe, expect, it } from "vitest";
import { CONVERSATIONS_MAX, MESSAGE_SEQ_MAX } from "./chat.ts";
import { AuthFrame, ClientFrame, FrameErrorCode, ResumeFrame, ServerFrame } from "./chat-frames.ts";

// The chat socket's contract (#349, ADR-031 §9): what the phone may send,
// what the API may answer, and nothing else.

const TOKEN = "A".repeat(43);
const ID = "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a70";
const OTHER = "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a71";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("what the phone sends", () => {
  it("authenticates with a session token only, and nothing beside it", () => {
    expect(AuthFrame.parse({ type: "auth", token: TOKEN })).toEqual({ type: "auth", token: TOKEN });
    for (const token of ["", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}!`, 43]) {
      expect(AuthFrame.safeParse({ type: "auth", token }).success, String(token)).toBe(false);
    }
    expect(AuthFrame.safeParse({ type: "auth", token: TOKEN, body: "x" }).success).toBe(false);
  });

  it("resumes each conversation once, by its id and a sequence in bounds, up to twice the list's bound", () => {
    expect(ResumeFrame.parse({ type: "resume", conversations: [] }).conversations).toEqual([]);
    const two = [
      { id: ID, seq: 0 },
      { id: OTHER, seq: MESSAGE_SEQ_MAX },
    ];
    expect(ResumeFrame.parse({ type: "resume", conversations: two }).conversations).toEqual(two);
    const refused = [
      [
        { id: ID, seq: 0 },
        { id: ID, seq: 1 },
      ],
      [{ id: "nope", seq: 0 }],
      [{ id: ID, seq: -1 }],
      [{ id: ID, seq: MESSAGE_SEQ_MAX + 1 }],
      [{ id: ID, seq: 1.5 }],
      [{ id: ID }],
      [{ id: ID, seq: 0, extra: true }],
    ];
    for (const conversations of refused) {
      expect(ResumeFrame.safeParse({ type: "resume", conversations }).success).toBe(false);
    }
    const most = Array.from({ length: CONVERSATIONS_MAX * 2 }, (_, i) => ({ id: id(i), seq: 0 }));
    expect(ResumeFrame.safeParse({ type: "resume", conversations: most }).success).toBe(true);
    expect(
      ResumeFrame.safeParse({
        type: "resume",
        conversations: [...most, { id: id(CONVERSATIONS_MAX * 2), seq: 0 }],
      }).success,
    ).toBe(false);
  });

  it("is an auth, a resume or a pong, strict, and nothing else", () => {
    expect(ClientFrame.parse({ type: "pong" })).toEqual({ type: "pong" });
    for (const frame of [
      { type: "pong", extra: 1 },
      { type: "typing" },
      { type: "ping" },
      {},
      null,
      "pong",
    ]) {
      expect(ClientFrame.safeParse(frame).success, JSON.stringify(frame)).toBe(false);
    }
  });
});

describe("what the API answers", () => {
  const message = {
    id: ID,
    seq: 1,
    side: "theirs",
    kind: "text",
    body: "Moi",
    createdAt: "2026-10-17T11:03:00.000Z",
    clientId: null,
  };

  it("is one of its seven frames, each strict", () => {
    const frames = [
      { type: "ready" },
      { type: "ping" },
      { type: "message", conversationId: ID, message },
      { type: "read", conversationId: ID, upTo: 0 },
      { type: "presence", conversationId: ID, online: true },
      { type: "conversation", conversationId: ID, state: "closed", closedHow: "erasure" },
      { type: "conversation", conversationId: ID, state: "gone", closedHow: null },
      { type: "error", code: "restarting" },
    ];
    for (const frame of frames) expect(ServerFrame.parse(frame)).toEqual(frame);
    const refused = [
      { type: "ready", extra: 1 },
      { type: "read", conversationId: ID, upTo: -1 },
      { type: "read", conversationId: ID, upTo: MESSAGE_SEQ_MAX + 1 },
      { type: "presence", conversationId: "nope", online: true },
      { type: "conversation", conversationId: ID, state: "blocked", closedHow: null },
      { type: "error", code: "blocked" },
      { type: "typing", conversationId: ID },
    ];
    for (const frame of refused) {
      expect(ServerFrame.safeParse(frame).success, JSON.stringify(frame)).toBe(false);
    }
  });

  it("names why it closes with one of its codes, never why a session ended", () => {
    expect(FrameErrorCode.options).toEqual([
      "bad_frame",
      "auth_timeout",
      "unauthenticated",
      "session_revoked",
      "session_expired",
      "too_many_sockets",
      "pong_timeout",
      "restarting",
      "internal_error",
    ]);
  });
});
