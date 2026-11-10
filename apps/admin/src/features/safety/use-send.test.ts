import { describe, expect, it } from "vitest";
import { codeOf } from "./use-send.ts";

describe("codeOf", () => {
  it("reads the envelope's code of a refusal", () => {
    expect(codeOf({ error: { code: "config_conflict", message: "x", requestId: "r" } })).toBe(
      "config_conflict",
    );
  });

  it.each([
    ["no answer", undefined],
    ["an envelope without a code", { error: { message: "x" } }],
    ["a body that is not the envelope", { message: "Bad Gateway" }],
  ])("reads no code from %s", (_, error) => {
    expect(codeOf(error)).toBeUndefined();
  });
});
