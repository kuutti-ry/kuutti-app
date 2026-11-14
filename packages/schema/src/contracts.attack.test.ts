import { describe, expect } from "vitest";
import type { z } from "zod";
import { ChatMessage, MessagesQuery, SendMessageRequest } from "./chat.ts";
import { ClientFrame, ServerFrame } from "./chat-frames.ts";
import { FeedbackList, FeedbackRequest } from "./feedback.ts";
import {
  AuthExchangeRequest,
  AuthExchangeResponse,
  AuthRefreshRequest,
  SessionTokens,
} from "./identity.ts";
import { GenderUpdate, PreferencesUpdate } from "./onboarding.ts";
import { RESEARCH_EVENTS, ResearchSnapshot } from "./research.ts";
import { attack } from "./test/attack.ts";

// CONTRACT pile (#380): hand-written wire payloads, rather than values made
// by the schema being tested. Every refusal has a payload the same boundary
// accepts, so a broken fixture or a validator refusing everything cannot pass.
const ID = "00000000-0000-4000-8000-000000000001";
const AT = "2026-11-01T12:00:00.000Z";
const token = "a".repeat(43);
const exchange = { code: token, verifier: "b".repeat(64) };
const session = {
  sessionId: ID,
  accessToken: token,
  accessExpiresAt: AT,
  refreshToken: `${token}.${token}`,
  refreshExpiresAt: AT,
};
const message = {
  id: ID,
  seq: 1,
  side: "theirs",
  kind: "text",
  body: "Hei",
  createdAt: AT,
  clientId: null,
  photo: null,
};
const feedback = {
  kind: "bug",
  text: "Painike ei vastaa",
  appVersion: "0.1.0",
  platform: "ios",
  locale: "fi",
};

type Probe = { name: string; schema: z.ZodType; bad: unknown; good: unknown };
const requests: Probe[] = [
  {
    name: "exchange a deep-link code without its verifier",
    schema: AuthExchangeRequest,
    bad: { code: token },
    good: exchange,
  },
  {
    name: "choose an account in an otherwise valid exchange",
    schema: AuthExchangeRequest,
    bad: { ...exchange, accountId: ID },
    good: exchange,
  },
  {
    name: "smuggle a trusted flag inside app attestation",
    schema: AuthExchangeRequest,
    bad: { ...exchange, attestation: { keyId: `${token}=`, attestation: "YWJj", trusted: true } },
    good: { ...exchange, attestation: { keyId: `${token}=`, attestation: "YWJj" } },
  },
  {
    name: "refresh with an access token in place of the two-part credential",
    schema: AuthRefreshRequest,
    bad: { refreshToken: token },
    good: { refreshToken: session.refreshToken },
  },
  {
    name: "supply an empty attestation assertion as present",
    schema: AuthRefreshRequest,
    bad: { refreshToken: session.refreshToken, assertion: "" },
    good: { refreshToken: session.refreshToken, assertion: "YWJj" },
  },
  {
    name: "repeat a sought gender to fill the preference list",
    schema: PreferencesUpdate,
    bad: { seeks: ["woman", "woman"] },
    good: { seeks: ["woman", "non_binary"] },
  },
  {
    name: "reverse the ends of the age window",
    schema: PreferencesUpdate,
    bad: { ageWindow: { min: 40, max: 39 } },
    good: { ageWindow: { min: 40, max: 40 } },
  },
  {
    name: "hide an override inside the nested age window",
    schema: PreferencesUpdate,
    bad: { ageWindow: { min: 18, max: 40, bypass: true } },
    good: { ageWindow: { min: 18, max: 40 } },
  },
  {
    name: "coerce string ages in a JSON preference body",
    schema: PreferencesUpdate,
    bad: { ageWindow: { min: "18", max: "40" } },
    good: { ageWindow: { min: 18, max: 40 } },
  },
  {
    name: "save an undeclared gender option",
    schema: GenderUpdate,
    bad: { gender: "unknown" },
    good: { gender: "non_binary" },
  },
  {
    name: "send NUL through the message boundary into Postgres text",
    schema: SendMessageRequest,
    bad: { clientId: ID, body: "hei\u0000" },
    good: { clientId: ID, body: "hei 👋" },
  },
  {
    name: "send a message consisting only of Unicode whitespace",
    schema: SendMessageRequest,
    bad: { clientId: ID, body: "\u2003\t\n" },
    good: { clientId: ID, body: "\u2003hei\n" },
  },
  {
    name: "request both history directions at once",
    schema: MessagesQuery,
    bad: { before: "2", after: "1" },
    good: { before: "2" },
  },
  {
    name: "write a message on the read-only socket",
    schema: ClientFrame,
    bad: { type: "message", conversationId: ID, body: "hei" },
    good: { type: "resume", conversations: [{ id: ID, seq: 0 }] },
  },
  {
    name: "amplify resume by naming the same conversation twice",
    schema: ClientFrame,
    bad: {
      type: "resume",
      conversations: [
        { id: ID, seq: 0 },
        { id: ID, seq: 1 },
      ],
    },
    good: { type: "resume", conversations: [{ id: ID, seq: 0 }] },
  },
  {
    name: "resume beyond the database sequence range",
    schema: ClientFrame,
    bad: { type: "resume", conversations: [{ id: ID, seq: 2147483648 }] },
    good: { type: "resume", conversations: [{ id: ID, seq: 2147483647 }] },
  },
  {
    name: "send a hidden attachment with feedback",
    schema: FeedbackRequest,
    bad: { ...feedback, attachment: "private-photo.jpg" },
    good: feedback,
  },
];
const responses: Probe[] = [
  {
    name: "read a session whose access token is truncated",
    schema: SessionTokens,
    bad: { ...session, accessToken: token.slice(1) },
    good: session,
  },
  {
    name: "read a numeric token expiry instead of an ISO instant",
    schema: SessionTokens,
    bad: { ...session, accessExpiresAt: 0 },
    good: session,
  },
  {
    name: "read an undocumented login outcome",
    schema: AuthExchangeResponse,
    bad: { ...session, outcome: "banned" },
    good: { ...session, outcome: "resumed" },
  },
  {
    name: "deliver a contact value over the change-only frame",
    schema: ServerFrame,
    bad: { type: "contacts", conversationId: ID, value: "+358401234567" },
    good: { type: "contacts", conversationId: ID },
  },
  {
    name: "tell the counterpart a block closed the conversation",
    schema: ServerFrame,
    bad: { type: "conversation", conversationId: ID, state: "closed", closedHow: "block" },
    good: { type: "conversation", conversationId: ID, state: "closed", closedHow: "unmatch" },
  },
  {
    name: "read a zero sequence as a stored chat message",
    schema: ChatMessage,
    bad: { ...message, seq: 0 },
    good: message,
  },
  {
    name: "read a string as a presence boolean",
    schema: ServerFrame,
    bad: { type: "presence", conversationId: ID, online: "false" },
    good: { type: "presence", conversationId: ID, online: false },
  },
  {
    name: "read a negative total from the feedback list",
    schema: FeedbackList,
    bad: { items: [], total: -1 },
    good: { items: [], total: 0 },
  },
];
const research: Probe[] = [
  {
    name: "accept a feedback event carrying the person's words",
    schema: RESEARCH_EVENTS.feedback_sent.props,
    bad: { kind: "bug", text: feedback.text },
    good: { kind: "bug" },
  },
  {
    name: "accept an exact location inside a research snapshot",
    schema: ResearchSnapshot,
    bad: { gender: "woman", fields: { intent: "long_term", postalCode: "00100" } },
    good: { gender: "woman", fields: { intent: "long_term" } },
  },
];

for (const [direction, probes] of [
  ["requests", requests],
  ["responses", responses],
  ["event boundary", research],
] as const) {
  describe(`contract attacks: ${direction} (#380)`, () => {
    for (const { name, schema, bad, good } of probes) {
      attack(name, {
        attempt: () => schema.safeParse(bad),
        control: () => schema.safeParse(good),
        succeeds: (seen) => expect(seen.success).toBe(true),
      });
    }
  });
}
