import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AuthCallbackQuery,
  AuthExchangeRequest,
  AuthExchangeResponse,
  AuthPlatform,
  AuthRefreshRequest,
  AuthStartQuery,
  SessionResponse,
  SessionTokens,
} from "./identity.ts";

// The bank login's contracts (#33, #35) at their boundaries.

const codes = (schema: z.ZodType, input: unknown) =>
  schema.safeParse(input).error?.issues.map((issue) => issue.code) ?? [];

const token = "Zz09_-".padEnd(43, "q");
const at = "2026-10-01T12:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("the start of a login", () => {
  it.each(["ios", "android"])("sends the code back to the %s app", (platform) => {
    expect(AuthStartQuery.parse({ platform })).toEqual({ platform });
  });

  it("refuses a web platform, a missing one and an unknown language", () => {
    expect(codes(AuthPlatform, "web")).toEqual(["invalid_value"]);
    expect(codes(AuthStartQuery, {})).toEqual(["invalid_value"]);
    expect(codes(AuthStartQuery, { platform: "ios", locale: "et" })).toEqual(["invalid_value"]);
  });

  it.each(["fi", "sv", "en"])("passes the bank chooser the language %s", (locale) => {
    expect(AuthStartQuery.parse({ platform: "android", locale })).toEqual({
      platform: "android",
      locale,
    });
  });
});

describe("the bank's callback", () => {
  it("takes a code and the state, or the bank's error and the state", () => {
    expect(AuthCallbackQuery.parse({ code: "c", state: "s" })).toEqual({ code: "c", state: "s" });
    const cancelled = { state: "s", error: "access_denied", error_description: "cancel" };
    expect(AuthCallbackQuery.parse(cancelled)).toEqual(cancelled);
  });

  it.each([
    ["no state", { code: "c" }, "invalid_type"],
    ["an empty state", { state: "" }, "too_small"],
    ["an empty code", { code: "", state: "s" }, "too_small"],
    ["an error of 65 characters", { state: "s", error: "e".repeat(65) }, "too_big"],
    [
      "a description of 257 characters",
      { state: "s", error_description: "d".repeat(257) },
      "too_big",
    ],
  ])("refuses %s", (_, query, code) => {
    expect(codes(AuthCallbackQuery, query)).toEqual([code]);
  });

  it("takes an error of 64 and a description of 256 characters", () => {
    const longest = { state: "s", error: "e".repeat(64), error_description: "d".repeat(256) };
    expect(AuthCallbackQuery.safeParse(longest).success).toBe(true);
  });
});

describe("the one-time code and the session tokens", () => {
  it.each([
    [token, true],
    ["A".repeat(42), false],
    ["A".repeat(44), false],
    [`${"A".repeat(42)}/`, false],
    [`${"A".repeat(42)}=`, false],
    [`${"A".repeat(42)} `, false],
  ])("takes %s as a one-time code and a refresh token: %s", (code, ok) => {
    expect(AuthExchangeRequest.safeParse({ code }).success).toBe(ok);
    expect(AuthRefreshRequest.safeParse({ refreshToken: code }).success).toBe(ok);
  });

  it("refuses an exchange or a refresh with an extra field", () => {
    expect(codes(AuthExchangeRequest, { code: token, platform: "ios" })).toEqual([
      "unrecognized_keys",
    ]);
    expect(codes(AuthRefreshRequest, { refreshToken: token, accessToken: token })).toEqual([
      "unrecognized_keys",
    ]);
  });

  const tokens = {
    sessionId: uuid(1),
    accessToken: token,
    accessExpiresAt: at,
    refreshToken: token,
    refreshExpiresAt: at,
  };

  it("hands the device both tokens, their ends and the session's id", () => {
    expect(SessionTokens.parse(tokens)).toEqual(tokens);
  });

  it.each(["created", "resumed"])("says whether the login %s the account", (outcome) => {
    expect(AuthExchangeResponse.parse({ ...tokens, outcome }).outcome).toBe(outcome);
  });

  it.each([
    ["an unknown outcome", { outcome: "restored" }],
    ["an access token of the wrong shape", { outcome: "created", accessToken: "x" }],
    ["a session id that is not a uuid", { outcome: "created", sessionId: "s-1" }],
    ["an end that is not a timestamp", { outcome: "created", refreshExpiresAt: "soon" }],
  ])("refuses %s", (_, change) => {
    expect(AuthExchangeResponse.safeParse({ ...tokens, ...change }).success).toBe(false);
  });

  it("tells the app about its own session only", () => {
    const own = {
      sessionId: uuid(1),
      accountId: uuid(2),
      platform: "ios",
      createdAt: at,
      refreshExpiresAt: at,
    };
    expect(SessionResponse.parse(own)).toEqual(own);
    expect(SessionResponse.parse({ ...own, hetuHmac: "x" })).not.toHaveProperty("hetuHmac");
    expect(codes(SessionResponse, { ...own, accountId: "me" })).toEqual(["invalid_format"]);
  });
});
