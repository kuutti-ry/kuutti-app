import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  ExportedNotifications,
  NOTICES_MAX,
  NoticeKind,
  Notices,
  NotificationChoices,
  NotificationKind,
  NotificationKindParams,
  PushData,
  PushPlatform,
  PushTokenRequest,
  PutNotificationChoice,
} from "./notifications.ts";

// The notification choices and the notices (#176, ADR-032) at their boundaries.

const codes = (schema: z.ZodType, input: unknown) =>
  schema.safeParse(input).error?.issues.map((issue) => issue.code) ?? [];
const at = "2026-10-18T09:00:00.000Z";
const notice = {
  id: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  kind: "warning",
  at,
  readAt: null,
  reason: "harassment",
};

describe("the notification choices", () => {
  it("are four kinds, in the order Settings lists them", () => {
    expect(NotificationKind.options).toEqual(["round", "message", "match", "moderation"]);
    expect(NotificationKindParams.parse({ kind: "match" })).toEqual({ kind: "match" });
    expect(codes(NotificationKindParams, { kind: "push" })).toEqual(["invalid_value"]);
  });

  it("take a boolean and nothing else", () => {
    expect(PutNotificationChoice.parse({ enabled: false })).toEqual({ enabled: false });
    expect(codes(PutNotificationChoice, { enabled: "no" })).toEqual(["invalid_type"]);
    expect(codes(PutNotificationChoice, {})).toEqual(["invalid_type"]);
    expect(codes(PutNotificationChoice, { enabled: true, kind: "round" })).toEqual([
      "unrecognized_keys",
    ]);
    const all = NotificationKind.options.map((kind) => ({ kind, enabled: true }));
    expect(NotificationChoices.parse({ choices: all }).choices).toHaveLength(4);
    expect(codes(NotificationChoices, { choices: [...all, all[0]] })).toEqual(["too_big"]);
  });
});

describe("the notices", () => {
  it("carry a warning's reason, and no more than a screen of them", () => {
    expect(NoticeKind.options).toEqual(["warning", "invitation_counted"]);
    expect(Notices.parse({ notices: [notice] }).notices).toEqual([notice]);
    expect(codes(Notices, { notices: [{ ...notice, reason: "rude" }] })).toEqual(["invalid_value"]);
    expect(codes(Notices, { notices: [{ ...notice, kind: "match" }] })).toEqual(["invalid_union"]);
    expect(
      codes(Notices, { notices: Array.from({ length: NOTICES_MAX + 1 }, () => notice) }),
    ).toEqual(["too_big"]);
  });

  it("carry a counted invitation's reward, and never who was invited (#107)", () => {
    const counted = {
      id: notice.id,
      kind: "invitation_counted",
      at,
      readAt: at,
      reward: { fish: 1, likes: 0 },
    };
    expect(Notices.parse({ notices: [counted, notice] }).notices).toEqual([counted, notice]);
    const named = Notices.parse({ notices: [{ ...counted, invitee: "Sanna" }] }).notices[0];
    expect(named).toEqual(counted);
    // Each kind carries its own: a warning has no reward, a counted invitation no reason.
    expect(
      codes(Notices, { notices: [{ ...counted, reward: undefined, reason: "other" }] }),
    ).toEqual(["invalid_type"]);
    const { reason: _reason, ...noReason } = notice;
    expect(codes(Notices, { notices: [{ ...noReason, reward: { fish: 1, likes: 0 } }] })).toEqual([
      "invalid_value",
    ]);
    expect(codes(Notices, { notices: [{ ...counted, reward: { fish: -1, likes: 0 } }] })).toEqual([
      "too_small",
    ]);
  });

  it("are exported with their kind and dates, never a reason", () => {
    const exported = ExportedNotifications.parse({
      choices: [{ kind: "message", enabled: false }],
      notices: [
        { kind: "warning", at, readAt: at, reason: "other" },
        { kind: "invitation_counted", at, readAt: null, reward: { fish: 1, likes: 0 } },
      ],
    });
    expect(exported.notices).toEqual([
      { kind: "warning", at, readAt: at },
      { kind: "invitation_counted", at, readAt: null },
    ]);
  });
});

// The push (#102, ADR-055): a device's token, and what a push's data carries.
describe("a device's push token", () => {
  const token = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";

  it("is either of Expo's two spellings, with a platform of the phone app's", () => {
    expect(PushPlatform.options).toEqual(["ios", "android"]);
    expect(PushTokenRequest.parse({ token, platform: "ios" })).toEqual({ token, platform: "ios" });
    expect(
      PushTokenRequest.parse({ token: "ExpoPushToken[a-b_C9]", platform: "android" }).token,
    ).toBe("ExpoPushToken[a-b_C9]");
  });

  it.each([
    ["no brackets", "ExponentPushToken"],
    ["empty brackets", "ExponentPushToken[]"],
    ["another prefix", "FcmToken[abc]"],
    ["a space inside", "ExponentPushToken[abc def]"],
    ["text after the bracket", "ExponentPushToken[abc]x"],
    ["a device token alone", "f0e1d2c3b4a5"],
    ["over 160 inside", `ExponentPushToken[${"a".repeat(161)}]`],
  ])("refuses %s", (_, value) => {
    expect(PushTokenRequest.safeParse({ token: value, platform: "ios" }).success).toBe(false);
  });

  it("refuses a web platform, a missing field and an unknown key", () => {
    expect(codes(PushTokenRequest, { token, platform: "web" })).toEqual(["invalid_value"]);
    expect(codes(PushTokenRequest, { token })).toEqual(["invalid_value"]);
    expect(codes(PushTokenRequest, { platform: "ios" })).toEqual(["invalid_type"]);
    expect(codes(PushTokenRequest, { token, platform: "ios", locale: "fi" })).toEqual([
      "unrecognized_keys",
    ]);
  });
});

describe("a push's data", () => {
  it("names its kind and nothing else", () => {
    for (const kind of ["message", "match", "round"] as const) {
      expect(PushData.parse({ kind })).toEqual({ kind });
    }
  });

  it("refuses an unknown kind and anything besides the kind: a conversation, a text, a name", () => {
    expect(codes(PushData, { kind: "moderation" })).toEqual(["invalid_value"]);
    expect(codes(PushData, {})).toEqual(["invalid_value"]);
    // Both people's phones would carry the same conversation id (the maintainer's of 25/10/2026).
    expect(
      codes(PushData, { kind: "message", conversationId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b" }),
    ).toEqual(["unrecognized_keys"]);
    expect(codes(PushData, { kind: "message", body: "Moi", from: "Ilmatar" })).toEqual([
      "unrecognized_keys",
    ]);
  });
});
