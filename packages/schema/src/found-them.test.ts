import { describe, expect, it } from "vitest";
import { FoundReason, FoundThemRequest, FoundThemStatus } from "./found-them.ts";

// "Löysin hänet" (#83, ADR-040): three reasons, closed; the reason alone in
// the request; whether the account answered, never which reason, in the read.

describe("the reasons", () => {
  it("are three, closed: on Kuutti, elsewhere, another", () => {
    expect(FoundReason.options).toEqual(["here", "elsewhere", "other"]);
  });
});

describe("the request", () => {
  it.each(FoundReason.options)("takes %s alone", (reason) => {
    expect(FoundThemRequest.parse({ reason })).toEqual({ reason });
  });

  it.each([
    ["no reason", {}],
    ["a reason off the list", { reason: "dating" }],
    ["a reason of the wrong type", { reason: 1 }],
    ["the reason in another case", { reason: "Here" }],
    ["words beside the reason", { reason: "other", text: "met at a dance" }],
    ["nothing at all", null],
  ])("refuses %s", (_case, body) => {
    expect(FoundThemRequest.safeParse(body).success).toBe(false);
  });
});

describe("the read", () => {
  it.each([true, false])("says answered: %s, and nothing else", (answered) => {
    expect(FoundThemStatus.parse({ answered })).toEqual({ answered });
    expect(FoundThemStatus.safeParse({ answered, reason: "here" }).success).toBe(false);
    expect(FoundThemStatus.safeParse({ answered: String(answered) }).success).toBe(false);
  });
});
