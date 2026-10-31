import { describe, expect, it } from "vitest";
import { AdminPond, AdminPondList, PondIdParams, PondMatchingChange } from "./ponds-admin.ts";

// The ponds in the panel (#500, ADR-060 §2): each with its switch, and the
// press that turns it, which says which way and nothing else.

const pond = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "suomi",
  name: "Suomi",
  nameInessive: "Suomessa",
  parentId: null,
  matchingOpen: false,
};

describe("a pond in the panel", () => {
  it("is a pond with its switch", () => {
    expect(AdminPond.parse(pond)).toEqual(pond);
    expect(AdminPondList.parse({ items: [pond] })).toEqual({ items: [pond] });
  });

  it.each([
    ["no switch", { matchingOpen: undefined }],
    ["a switch that is no boolean", { matchingOpen: "yes" }],
    ["an id that is not a uuid", { id: "suomi" }],
  ])("refuses %s", (_, change) => {
    expect(AdminPond.safeParse({ ...pond, ...change }).success).toBe(false);
  });

  it("holds the list to its bound", () => {
    expect(AdminPondList.safeParse({ items: Array(201).fill(pond) }).success).toBe(false);
  });

  it("takes a pond's id as a uuid", () => {
    expect(PondIdParams.safeParse({ id: pond.id }).success).toBe(true);
    expect(PondIdParams.safeParse({ id: "suomi" }).success).toBe(false);
  });
});

describe("a press of the switch", () => {
  it.each([true, false])("says which way: %s", (open) => {
    expect(PondMatchingChange.parse({ open })).toEqual({ open });
  });

  it.each([
    ["nothing", {}],
    ["no boolean", { open: "true" }],
    ["a reason, which the audit row has no room for", { open: true, reason: "ready" }],
  ])("refuses %s", (_, input) => {
    expect(PondMatchingChange.safeParse(input).success).toBe(false);
  });
});
