import { describe, expect, it } from "vitest";
import { GateResponse, GateState } from "./gate.ts";

// Whether matching is open, as the person is told it (#500, ADR-060 §4): three
// states and nothing else, so no figure can reach the home card.

describe("what a person is told of their matching", () => {
  it.each(["incomplete", "closed", "open"] as const)("says %s", (state) => {
    expect(GateResponse.parse({ state })).toEqual({ state });
  });

  it.each(["pending", "waiting", "admitted", ""])("has no state %j", (state) => {
    expect(GateState.safeParse(state).success).toBe(false);
  });

  it.each([
    ["a place in a line", { within: 10 }],
    ["a number needed", { needed: 10 }],
    ["a step", { step: 10 }],
  ])("says no %s", (_, more) => {
    expect(GateResponse.safeParse({ state: "closed", ...more }).success).toBe(false);
  });

  it.each([
    ["nothing", {}],
    ["a state of another type", { state: 1 }],
    ["no object", "open"],
  ])("refuses %s", (_, input) => {
    expect(GateResponse.safeParse(input).success).toBe(false);
  });
});
