import { describe, expect, it } from "vitest";
import { ErrorResponse } from "./errors.ts";

// The one error envelope every route returns.

const envelope = { error: { code: "photo_limit", message: "Too many photos", requestId: "r-1" } };

describe("the error envelope", () => {
  it("carries a code, a message and the request id", () => {
    expect(ErrorResponse.parse(envelope)).toEqual(envelope);
  });

  it.each(["code", "message", "requestId"])("refuses an empty %s", (key) => {
    const result = ErrorResponse.safeParse({ error: { ...envelope.error, [key]: "" } });
    expect(result.error?.issues.map((issue) => [issue.code, issue.path.join(".")])).toEqual([
      ["too_small", `error.${key}`],
    ]);
  });

  it.each(["code", "message", "requestId"])("refuses a missing %s", (key) => {
    const { [key as keyof typeof envelope.error]: _, ...rest } = envelope.error;
    expect(ErrorResponse.safeParse({ error: rest }).success).toBe(false);
  });

  it("refuses a bare string in place of the object", () => {
    expect(ErrorResponse.safeParse({ error: "photo_limit" }).success).toBe(false);
  });
});
