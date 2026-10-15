import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PROFILE_FIELD_KEYS, PROFILE_FIELDS, SPECIAL_CATEGORY_FIELDS } from "./profile-fields.ts";
import {
  AGE_BANDS,
  ageBandOf,
  RESEARCH_EVENT_NAMES,
  RESEARCH_EVENTS,
  RESEARCH_FIELD_KEYS,
  RESEARCH_K_MIN,
  ResearchSnapshot,
  researchFieldsOf,
} from "./research.ts";
import { WAITLIST_K_MIN } from "./waitlist.ts";

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
    case "account_paused":
      return {};
    case "account_resumed":
      return { afterDays: 3 };
    case "feedback_sent":
      return { kind: "bug" };
  }
}

describe("the coarse snapshot", () => {
  it("takes only the single-choice fields flagged for research: never a multi, a text, a number, a setting or a special-category field", () => {
    for (const key of RESEARCH_FIELD_KEYS) {
      const spec = PROFILE_FIELDS[key];
      expect(spec.research, key).toBe(true);
      expect(spec.kind, key).toBe("single");
      expect(spec.role, key).not.toBe("hidden");
      expect(SPECIAL_CATEGORY_FIELDS).not.toContain(key);
    }
    for (const key of PROFILE_FIELD_KEYS) {
      const spec = PROFILE_FIELDS[key];
      if (spec.kind !== "single" || !spec.research) expect(RESEARCH_FIELD_KEYS).not.toContain(key);
    }
    for (const key of [
      "hobbies",
      "languages",
      "occupationTitle",
      "height",
      "hideFromField",
      "politics",
      "religion",
    ]) {
      expect(RESEARCH_FIELD_KEYS).not.toContain(key);
    }
    // The allow-list of ADR-011 §9: intent alone until the census says a second field fits.
    expect(RESEARCH_FIELD_KEYS).toEqual(["intent"]);
  });

  it("holds k to the waitlist's floor of ten", () => {
    expect(RESEARCH_K_MIN).toBe(10);
    expect(RESEARCH_K_MIN).toBe(WAITLIST_K_MIN);
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
    // The languages are a closed list too, and still out: not flagged (ADR-011 §9).
    expect(fields).toEqual({ intent: "long_term" });
    // A retired option of the flagged field is left out, not copied; a missing one adds nothing.
    expect(researchFieldsOf({ intent: "retired option" })).toEqual({});
    expect(researchFieldsOf({ languages: ["fi"] })).toEqual({});
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
});
