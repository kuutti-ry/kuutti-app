import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PROFILE_FIELD_KEYS, PROFILE_FIELDS, SPECIAL_CATEGORY_FIELDS } from "./profile-fields.ts";
import {
  AGE_BANDS,
  ageBandOf,
  RESEARCH_EVENT_NAMES,
  RESEARCH_EVENTS,
  RESEARCH_FIELD_KEYS,
  ResearchEventRecord,
  ResearchSnapshot,
  researchFieldsOf,
} from "./research.ts";

// The event registry and the coarse snapshot (#50, ADR-011, rules/schema.md).

describe("the event registry", () => {
  it("names every event with the question it answers and a strict props schema", () => {
    expect(RESEARCH_EVENT_NAMES.length).toBeGreaterThan(0);
    for (const name of RESEARCH_EVENT_NAMES) {
      const spec = RESEARCH_EVENTS[name];
      expect(spec.question.length, name).toBeGreaterThan(20);
      expect(spec.props.safeParse({ unexpected: 1, ...valid(name) }).success, name).toBe(false);
      expect(spec.props.safeParse(valid(name)).success, name).toBe(true);
    }
  });

  it("carries no free text in any props schema, however deep", () => {
    for (const name of RESEARCH_EVENT_NAMES) {
      expect(hasStringNode(RESEARCH_EVENTS[name].props), name).toBe(false);
    }
    // The check itself sees through wrappers, arrays and nested objects.
    expect(hasStringNode(z.object({ n: z.int(), ok: z.boolean().optional() }))).toBe(false);
    expect(hasStringNode(z.object({ note: z.array(z.string()) }))).toBe(true);
    expect(hasStringNode(z.object({ inner: z.object({ text: z.string().nullable() }) }))).toBe(
      true,
    );
    expect(hasStringNode(z.object({ e: z.enum(["a", "b"]) }))).toBe(false);
  });
});

type Def = {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: z.ZodType[];
  valueType?: z.ZodType;
};

/** True when a zod schema contains a string node anywhere: the registry may carry none (rules/schema.md). */
function hasStringNode(schema: z.ZodType): boolean {
  const def = schema.def as Def;
  switch (def.type) {
    case "string":
      return true;
    case "object":
      return Object.values(def.shape ?? {}).some(hasStringNode);
    case "array":
      return def.element ? hasStringNode(def.element) : false;
    case "optional":
    case "nullable":
    case "default":
      return def.innerType ? hasStringNode(def.innerType) : false;
    case "union":
      return (def.options ?? []).some(hasStringNode);
    case "record":
      return def.valueType ? hasStringNode(def.valueType) : false;
    default:
      return false;
  }
}

function valid(name: (typeof RESEARCH_EVENT_NAMES)[number]): Record<string, unknown> {
  switch (name) {
    case "research_opt_in":
      return { sinceRegistrationD: 3, accountActive: true };
    case "profile_saved":
      return { complete: false, approvedPhotos: 2 };
  }
}

describe("the coarse snapshot", () => {
  it("takes the closed-list fields only: never a text, a number, a setting or a special-category field", () => {
    for (const key of RESEARCH_FIELD_KEYS) {
      expect(["single", "multi"]).toContain(PROFILE_FIELDS[key].kind);
      expect(PROFILE_FIELDS[key].role).not.toBe("hidden");
      expect(SPECIAL_CATEGORY_FIELDS).not.toContain(key);
    }
    for (const key of PROFILE_FIELD_KEYS) {
      const spec = PROFILE_FIELDS[key];
      if (spec.kind === "text" || spec.kind === "number" || spec.kind === "flag") {
        expect(RESEARCH_FIELD_KEYS).not.toContain(key);
      }
    }
    for (const key of ["occupationTitle", "height", "hideFromField", "politics", "religion"]) {
      expect(RESEARCH_FIELD_KEYS).not.toContain(key);
    }
    expect(RESEARCH_FIELD_KEYS).toContain("hobbies");
  });

  it("keeps a stored value only while the registry still knows it, and drops the rest", () => {
    const fields = researchFieldsOf({
      intent: "long_term",
      languages: ["fi", "en"],
      smoking: "retired option",
      occupationTitle: "Guild of something",
      height: 180,
      politics: ["vihr"],
      displayName: "Not a field",
      seeks: ["woman"],
    });
    expect(fields).toEqual({ intent: "long_term", languages: ["fi", "en"] });
    expect(researchFieldsOf(null)).toEqual({});
    expect(researchFieldsOf("text")).toEqual({});
    expect(ResearchSnapshot.safeParse({ gender: null, fields }).success).toBe(true);
    expect(
      ResearchSnapshot.safeParse({ gender: null, fields: { occupationTitle: "x" } }).success,
    ).toBe(false);
    expect(
      ResearchSnapshot.safeParse({ gender: null, fields: { politics: ["vihr"] } }).success,
    ).toBe(false);
  });

  it("bands the age at the documented edges", () => {
    expect(ageBandOf(18)).toBe("18-24");
    expect(ageBandOf(24)).toBe("18-24");
    expect(ageBandOf(25)).toBe("25-29");
    expect(ageBandOf(29)).toBe("25-29");
    expect(ageBandOf(30)).toBe("30-34");
    expect(ageBandOf(35)).toBe("35-39");
    expect(ageBandOf(40)).toBe("40-49");
    expect(ageBandOf(49)).toBe("40-49");
    expect(ageBandOf(50)).toBe("50+");
    expect(ageBandOf(97)).toBe("50+");
    for (const age of [18, 25, 30, 35, 40, 50]) expect(AGE_BANDS).toContain(ageBandOf(age));
  });

  it("describes an exported event without any id", () => {
    const record = ResearchEventRecord.parse({
      name: "profile_saved",
      at: "2026-09-26T12:00:00.000Z",
      consentVersion: "2026-09-draft-1",
      pond: null,
      ageBand: "30-34",
      snapshot: { gender: "woman", fields: {} },
      props: { complete: true, approvedPhotos: 3 },
    });
    expect(Object.keys(record).sort()).toEqual([
      "ageBand",
      "at",
      "consentVersion",
      "name",
      "pond",
      "props",
      "snapshot",
    ]);
  });
});
