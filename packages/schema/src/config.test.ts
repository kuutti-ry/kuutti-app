import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  CONFIG_REASON_MAX,
  ConfigChangeRequest,
  ConfigKey,
  ConfigKeyName,
  ConfigKeyParams,
  ConfigList,
  ConfigValue,
  ConfigVersion,
} from "./config.ts";

// The tunables contract (#304, #305): the keys of matching_config as the
// panel reads them, and a new version with a reason as an admin writes it,
// at their boundaries.

/** Each issue as "code at path", the path empty for the input itself. */
const refusal = (schema: z.ZodType, input: unknown) =>
  schema
    .safeParse(input)
    .error?.issues.map((issue) => `${issue.code} at ${issue.path.join(".")}`) ?? [];

const at = "2026-10-16T09:00:00.000Z";
const budgets = { thumb: 600, card: 300, full: 60 };
const seeded = { version: 1, value: 30, validFrom: at, createdBy: "seed", reason: null };
const changed = {
  version: 2,
  value: 25,
  validFrom: at,
  createdBy: "00000000-0000-4000-8000-000000000001",
  reason: "Smaller ponds first",
};
const gateK = { key: "gate_k", value: 25, version: 2, versions: [changed, seeded] };
const many = <T>(n: number, item: T) => Array.from({ length: n }, () => item);

describe("a key's name", () => {
  it.each([
    ["one letter", "a"],
    ["letters, a digit and an underscore", "a1_b"],
    ["a key of matching_config", "photo_fetches_per_day"],
    ["64 characters", "a".repeat(64)],
  ])("takes %s", (_what, name) => {
    expect(ConfigKeyName.parse(name)).toBe(name);
  });

  it.each([
    ["65 characters", "a".repeat(65)],
    ["upper case", "Gate_k"],
    ["only upper case", "A"],
    ["a leading digit", "1a"],
    ["a leading underscore", "_a"],
    ["a dash", "gate-k"],
    ["a space", "gate k"],
    ["a letter outside ASCII", "pää"],
    ["an empty string", ""],
  ])("refuses %s", (_what, name) => {
    expect(refusal(ConfigKeyName, name)).toEqual(["invalid_format at "]);
  });

  it("refuses what is not a string", () => {
    expect(refusal(ConfigKeyName, 5)).toEqual(["invalid_type at "]);
    expect(refusal(ConfigKeyName, null)).toEqual(["invalid_type at "]);
  });

  it("is the route's only parameter, the same rule", () => {
    expect(ConfigKeyParams.parse({ key: "gate_k" })).toEqual({ key: "gate_k" });
    expect(refusal(ConfigKeyParams, { key: "Gate_k" })).toEqual(["invalid_format at key"]);
    expect(refusal(ConfigKeyParams, { key: "a".repeat(65) })).toEqual(["invalid_format at key"]);
    expect(refusal(ConfigKeyParams, {})).toEqual(["invalid_type at key"]);
  });
});

describe("a value", () => {
  it.each([
    ["a whole number", 30],
    ["a fraction", 0.6],
    ["zero", 0],
    ["a negative number", -1],
    ["a string", "paakaupunkiseutu"],
    ["an empty string", ""],
    ["true", true],
    ["false", false],
    ["the photo fetch budgets", budgets],
    ["a flat object of a string, a number and a boolean", { a: "x", b: 1, c: false }],
    ["an empty object", {}],
  ])("takes %s", (_what, value) => {
    expect(ConfigValue.parse(value)).toEqual(value);
  });

  it.each([
    ["null", null],
    ["nothing", undefined],
    ["an empty array", []],
    ["an array of numbers", [1, 2]],
    ["a nested object", { thumb: { max: 600 } }],
    ["an object with a null", { ...budgets, full: null }],
    ["an object with an array", { ...budgets, full: [60] }],
    ["not a number, which JSON cannot hold", Number.NaN],
    ["infinity, which JSON cannot hold", Number.POSITIVE_INFINITY],
  ])("refuses %s", (_what, value) => {
    expect(refusal(ConfigValue, value)).toEqual(["invalid_union at "]);
  });
});

describe("a version as the panel reads it", () => {
  it("takes the seed's version without a reason and the panel's with one", () => {
    expect(ConfigVersion.parse(seeded)).toEqual(seeded);
    expect(ConfigVersion.parse(changed)).toEqual(changed);
    expect(ConfigVersion.parse({ ...changed, value: budgets }).value).toEqual(budgets);
  });

  it("takes a reason of 500 characters and refuses 501", () => {
    expect(CONFIG_REASON_MAX).toBe(500);
    const full = "x".repeat(CONFIG_REASON_MAX);
    expect(ConfigVersion.parse({ ...changed, reason: full }).reason).toBe(full);
    expect(refusal(ConfigVersion, { ...changed, reason: `${full}x` })).toEqual([
      "too_big at reason",
    ]);
  });

  it("needs the reason said, null where none was kept", () => {
    const { reason: _, ...withoutReason } = seeded;
    expect(refusal(ConfigVersion, withoutReason)).toEqual(["invalid_type at reason"]);
  });

  it.each([
    ["version 0", { version: 0 }, "too_small at version"],
    ["a fractional version", { version: 1.5 }, "invalid_type at version"],
    ["a version as a string", { version: "1" }, "invalid_type at version"],
    ["a day instead of an instant", { validFrom: "2026-10-16" }, "invalid_format at validFrom"],
    [
      "an instant with an offset",
      { validFrom: "2026-10-16T12:00:00+03:00" },
      "invalid_format at validFrom",
    ],
    ["no author", { createdBy: undefined }, "invalid_type at createdBy"],
    ["a nested value", { value: { thumb: { max: 1 } } }, "invalid_union at value"],
    ["no value", { value: undefined }, "invalid_union at value"],
  ])("refuses %s", (_what, change, issue) => {
    expect(refusal(ConfigVersion, { ...seeded, ...change })).toEqual([issue]);
  });
});

describe("a key as the panel reads it", () => {
  it("takes a key with its versions, newest first", () => {
    expect(ConfigKey.parse(gateK)).toEqual(gateK);
  });

  it("has at least one version and at most 1000", () => {
    expect(refusal(ConfigKey, { ...gateK, versions: [] })).toEqual(["too_small at versions"]);
    expect(ConfigKey.parse({ ...gateK, versions: [seeded] }).versions).toHaveLength(1);
    expect(ConfigKey.parse({ ...gateK, versions: many(1000, seeded) }).versions).toHaveLength(1000);
    expect(refusal(ConfigKey, { ...gateK, versions: many(1001, seeded) })).toEqual([
      "too_big at versions",
    ]);
  });

  it("refuses a name outside the rule, version 0, a nested value and a version that does not parse", () => {
    expect(refusal(ConfigKey, { ...gateK, key: "Gate_k" })).toEqual(["invalid_format at key"]);
    expect(refusal(ConfigKey, { ...gateK, version: 0 })).toEqual(["too_small at version"]);
    expect(refusal(ConfigKey, { ...gateK, value: [25] })).toEqual(["invalid_union at value"]);
    expect(refusal(ConfigKey, { ...gateK, versions: [{ ...changed, reason: 7 }] })).toEqual([
      "invalid_type at versions.0.reason",
    ]);
  });
});

describe("the list of keys", () => {
  it("takes no keys, one, and 500", () => {
    expect(ConfigList.parse({ items: [] })).toEqual({ items: [] });
    expect(ConfigList.parse({ items: [gateK] })).toEqual({ items: [gateK] });
    expect(ConfigList.parse({ items: many(500, gateK) }).items).toHaveLength(500);
  });

  it("refuses 501 keys, a missing list and a key that does not parse", () => {
    expect(refusal(ConfigList, { items: many(501, gateK) })).toEqual(["too_big at items"]);
    expect(refusal(ConfigList, {})).toEqual(["invalid_type at items"]);
    expect(refusal(ConfigList, [gateK])).toEqual(["invalid_type at "]);
    expect(refusal(ConfigList, { items: [{ ...gateK, versions: [] }] })).toEqual([
      "too_small at items.0.versions",
    ]);
  });
});

describe("an admin's change", () => {
  const change = { value: 25, reason: "Smaller ponds first" };

  it("takes a value of each kind with a reason", () => {
    for (const value of [6, 0.55, "suomi", true, budgets]) {
      expect(ConfigChangeRequest.parse({ ...change, value })).toEqual({ ...change, value });
    }
  });

  it("takes a reason of one character and of 500, trimmed, and refuses 501, only whitespace or none", () => {
    expect(ConfigChangeRequest.parse({ ...change, reason: "x" }).reason).toBe("x");
    const full = "x".repeat(CONFIG_REASON_MAX);
    expect(ConfigChangeRequest.parse({ ...change, reason: full }).reason).toBe(full);
    // Whitespace around the words is not counted, and not kept.
    expect(ConfigChangeRequest.parse({ ...change, reason: `  ${full}\n` }).reason).toBe(full);
    expect(ConfigChangeRequest.parse({ ...change, reason: "\t two words  " }).reason).toBe(
      "two words",
    );
    expect(refusal(ConfigChangeRequest, { ...change, reason: `${full}x` })).toEqual([
      "too_big at reason",
    ]);
    expect(refusal(ConfigChangeRequest, { ...change, reason: "" })).toEqual([
      "too_small at reason",
    ]);
    expect(refusal(ConfigChangeRequest, { ...change, reason: " \n\t " })).toEqual([
      "too_small at reason",
    ]);
    expect(refusal(ConfigChangeRequest, { value: 25 })).toEqual(["invalid_type at reason"]);
    expect(refusal(ConfigChangeRequest, { ...change, reason: null })).toEqual([
      "invalid_type at reason",
    ]);
    expect(refusal(ConfigChangeRequest, { ...change, reason: 7 })).toEqual([
      "invalid_type at reason",
    ]);
  });

  it("refuses a missing value, null, an array and a nested object", () => {
    expect(refusal(ConfigChangeRequest, { reason: change.reason })).toEqual([
      "invalid_union at value",
    ]);
    for (const value of [null, [6], { thumb: { max: 600 } }, { ...budgets, full: null }]) {
      expect(refusal(ConfigChangeRequest, { ...change, value })).toEqual([
        "invalid_union at value",
      ]);
    }
  });

  it("refuses any key it does not define: the key, the version and the author are the API's", () => {
    for (const extra of [{ key: "gate_k" }, { version: 3 }, { createdBy: "someone" }]) {
      expect(refusal(ConfigChangeRequest, { ...change, ...extra })).toEqual([
        "unrecognized_keys at ",
      ]);
    }
  });

  it("refuses a body that is not an object", () => {
    expect(refusal(ConfigChangeRequest, null)).toEqual(["invalid_type at "]);
    expect(refusal(ConfigChangeRequest, [change])).toEqual(["invalid_type at "]);
    expect(refusal(ConfigChangeRequest, "25")).toEqual(["invalid_type at "]);
  });
});
