import { describe, expect, it } from "vitest";
import { ExportedGate, GateResponse, GateState } from "./gate.ts";
import { WAITLIST_K_MIN } from "./waitlist.ts";

// The pond gate as the person is told it (#94, ADR-015): `within` exactly
// when waiting, `needed` exactly when closed, both said in steps of at least k.

const step = WAITLIST_K_MIN;
const messages = (input: unknown) =>
  GateResponse.safeParse(input).error?.issues.map((issue) => issue.message) ?? [];

const WITHIN = "a place in the line is said exactly when the person waits";
const NEEDED = "how many are needed is said exactly when the gate is closed";

describe("the gate response", () => {
  it.each([
    ["incomplete", null, null],
    ["pending", null, null],
    ["waiting", 20, null],
    ["closed", null, 40],
    ["open", null, null],
  ])("says the %s state with within %s and needed %s", (state, within, needed) => {
    const gate = { state, within, needed, step };
    expect(GateResponse.parse(gate)).toEqual(gate);
  });

  it.each([
    ["waiting without a place", { state: "waiting", within: null, needed: null }, [WITHIN]],
    ["a place when not waiting", { state: "open", within: 10, needed: null }, [WITHIN]],
    ["closed without a count", { state: "closed", within: null, needed: null }, [NEEDED]],
    ["a count when not closed", { state: "pending", within: null, needed: 10 }, [NEEDED]],
    ["both when open", { state: "open", within: 10, needed: 10 }, [WITHIN, NEEDED]],
    ["closed with a place too", { state: "closed", within: 10, needed: 10 }, [WITHIN]],
  ])("refuses %s", (_, gate, expected) => {
    expect(messages({ ...gate, step })).toEqual(expected);
  });

  it("says the step as at least k and never finer", () => {
    expect(WAITLIST_K_MIN).toBe(10);
    const open = { state: "open", within: null, needed: null };
    expect(GateResponse.safeParse({ ...open, step: 10 }).success).toBe(true);
    expect(GateResponse.safeParse({ ...open, step: 50 }).success).toBe(true);
    expect(GateResponse.safeParse({ ...open, step: 9 }).success).toBe(false);
    expect(GateResponse.safeParse({ ...open, step: 10.5 }).success).toBe(false);
  });

  it("refuses a place or a count below one, an unknown state and an extra key", () => {
    expect(
      GateResponse.safeParse({ state: "waiting", within: 0, needed: null, step }).success,
    ).toBe(false);
    expect(GateResponse.safeParse({ state: "closed", within: null, needed: 0, step }).success).toBe(
      false,
    );
    expect(GateState.safeParse("admitted").success).toBe(false);
    expect(
      GateResponse.safeParse({ state: "open", within: null, needed: null, step, exact: 3 }).success,
    ).toBe(false);
  });
});

describe("the gate in the export", () => {
  const row = {
    pondId: "00000000-0000-4000-8000-000000000001",
    admittedAt: null,
    placeSaid: null,
    poolSaid: 0,
    openedAt: null,
    countedAt: null,
  };

  it("holds the row as said, nothing finer", () => {
    expect(ExportedGate.parse(row)).toEqual(row);
    const counted = { ...row, placeSaid: 30, poolSaid: 120, countedAt: "2026-10-01T03:00:00Z" };
    expect(ExportedGate.parse(counted)).toEqual(counted);
  });

  it.each([
    ["a place of zero", { placeSaid: 0 }],
    ["a negative pool", { poolSaid: -10 }],
    ["a pond id that is not a uuid", { pondId: "helsinki" }],
    ["a date that is not ISO 8601", { openedAt: "1.10.2026" }],
  ])("refuses %s", (_, change) => {
    expect(ExportedGate.safeParse({ ...row, ...change }).success).toBe(false);
  });
});
