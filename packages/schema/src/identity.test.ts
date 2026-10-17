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
/** 256 bits as lowercase hex: the shape of the app's verifier and of its challenge (ADR-027). */
const hex = "0123456789abcdef".repeat(4);
const at = "2026-10-01T12:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("the start of a login", () => {
  it.each(["ios", "android"])("sends the code back to the %s app", (platform) => {
    expect(AuthStartQuery.parse({ platform, code_challenge: hex })).toEqual({
      platform,
      code_challenge: hex,
    });
  });

  it("refuses a web platform, a missing one and an unknown language", () => {
    expect(codes(AuthPlatform, "web")).toEqual(["invalid_value"]);
    expect(codes(AuthStartQuery, { code_challenge: hex })).toEqual(["invalid_value"]);
    expect(codes(AuthStartQuery, { platform: "ios", locale: "et", code_challenge: hex })).toEqual([
      "invalid_value",
    ]);
  });

  it.each(["fi", "sv", "en"])("passes the bank chooser the language %s", (locale) => {
    expect(AuthStartQuery.parse({ platform: "android", locale, code_challenge: hex })).toEqual({
      platform: "android",
      locale,
      code_challenge: hex,
    });
  });

  it.each([
    ["no challenge", undefined, "invalid_type"],
    ["an empty one", "", "invalid_format"],
    ["upper-case hex", hex.toUpperCase(), "invalid_format"],
    ["63 characters", hex.slice(1), "invalid_format"],
    ["65 characters", `${hex}0`, "invalid_format"],
    ["a base64url SHA-256, as RFC 7636 would send it", token, "invalid_format"],
    ["hex with a character that is not", `${hex.slice(1)}g`, "invalid_format"],
    ["a number", 42, "invalid_type"],
  ])("refuses a start with %s as its code challenge", (_, challenge, code) => {
    expect(codes(AuthStartQuery, { platform: "ios", code_challenge: challenge })).toEqual([code]);
  });

  it("keeps of a start only what it knows, so a verifier sent with it goes no further", () => {
    expect(AuthStartQuery.parse({ platform: "ios", code_challenge: hex, verifier: hex })).toEqual({
      platform: "ios",
      code_challenge: hex,
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
    expect(AuthExchangeRequest.safeParse({ code, verifier: hex }).success).toBe(ok);
    expect(AuthRefreshRequest.safeParse({ refreshToken: code }).success).toBe(ok);
  });

  it.each([
    ["no verifier", undefined, "invalid_type"],
    ["an empty one", "", "invalid_format"],
    ["upper-case hex", hex.toUpperCase(), "invalid_format"],
    ["63 characters", hex.slice(1), "invalid_format"],
    ["65 characters", `${hex}0`, "invalid_format"],
    ["one in base64url", token, "invalid_format"],
    ["hex with a character that is not", `${hex.slice(1)}g`, "invalid_format"],
    ["a number", 42, "invalid_type"],
  ])("refuses an exchange with %s as its verifier", (_, verifier, code) => {
    expect(codes(AuthExchangeRequest, { code: token, verifier })).toEqual([code]);
  });

  it("takes the code with its verifier, and nothing else", () => {
    expect(AuthExchangeRequest.parse({ code: token, verifier: hex })).toEqual({
      code: token,
      verifier: hex,
    });
  });

  it("refuses an exchange or a refresh with an extra field", () => {
    expect(codes(AuthExchangeRequest, { code: token, verifier: hex, platform: "ios" })).toEqual([
      "unrecognized_keys",
    ]);
    // The code alone, as before the binding (ADR-027), lacks its verifier too.
    expect(codes(AuthExchangeRequest, { code: token, platform: "ios" })).toEqual([
      "invalid_type",
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
