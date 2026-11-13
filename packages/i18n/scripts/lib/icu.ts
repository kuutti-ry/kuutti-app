import { type MessageFormatElement, parse, TYPE } from "@formatjs/icu-messageformat-parser";
import { printAST } from "@formatjs/icu-messageformat-parser/printer.js";

/** What a caller must pass for one ICU argument. */
export type ArgumentType = "string" | "number" | "date";

/** Every argument of a message with the type its ICU format demands. Throws on invalid ICU. */
export function argumentsOf(message: string): Record<string, ArgumentType> {
  const found: Record<string, ArgumentType> = {};
  const visit = (elements: MessageFormatElement[]): void => {
    for (const el of elements) {
      switch (el.type) {
        case TYPE.argument:
          found[el.value] ??= "string";
          break;
        case TYPE.number:
          found[el.value] = "number";
          break;
        case TYPE.date:
        case TYPE.time:
          found[el.value] = "date";
          break;
        case TYPE.plural:
          found[el.value] = "number";
          for (const option of Object.values(el.options)) visit(option.value);
          break;
        case TYPE.select:
          found[el.value] ??= "string";
          for (const option of Object.values(el.options)) visit(option.value);
          break;
        case TYPE.tag:
          visit(el.children);
          break;
        default:
          break;
      }
    }
  };
  visit(parse(message));
  return found;
}

/** The names of the ICU tags (<b>…</b>) a message uses. Throws on invalid ICU. */
export function tagsOf(message: string): Set<string> {
  const found = new Set<string>();
  const visit = (elements: MessageFormatElement[]): void => {
    for (const el of elements) {
      if (el.type === TYPE.tag) {
        found.add(el.value);
        visit(el.children);
      } else if (el.type === TYPE.plural || el.type === TYPE.select) {
        for (const option of Object.values(el.options)) visit(option.value);
      }
    }
  };
  visit(parse(message));
  return found;
}

/** A plural, selectordinal or select argument and the branch names it has. */
type Branching = { kind: "plural" | "selectordinal" | "select"; options: Set<string> };

/** The branches of every plural, selectordinal and select argument. Throws on invalid ICU. */
export function branchesOf(message: string): Record<string, Branching> {
  const found: Record<string, Branching> = {};
  const visit = (elements: MessageFormatElement[]): void => {
    for (const el of elements) {
      if (el.type === TYPE.plural || el.type === TYPE.select) {
        const kind =
          el.type === TYPE.select
            ? "select"
            : el.pluralType === "ordinal"
              ? "selectordinal"
              : "plural";
        found[el.value] ??= { kind, options: new Set() };
        for (const [name, option] of Object.entries(el.options)) {
          found[el.value]?.options.add(name);
          visit(option.value);
        }
      } else if (el.type === TYPE.tag) {
        visit(el.children);
      }
    }
  };
  visit(parse(message));
  return found;
}

/**
 * A translation keeps every branch its reader needs: each plural form of its
 * own language (CLDR, through Intl.PluralRules), every exact case (=0) of the
 * English, and exactly the English select options (a gender or a state is a
 * decision in code, never one a translation adds or drops). Pass the English
 * as both arguments to check the source against English's own plural forms.
 */
export function branchProblems(en: string, text: string, locale: string): string[] {
  const problems: string[] = [];
  const source = branchesOf(en);
  const targets = branchesOf(text);
  // The argument check sees names and coarse types only ({count, plural, …} and
  // {count, number} are both numbers), so a branch the English has and the
  // translation flattened, or turned into another kind, is reported here. An
  // argument one side lacks altogether is the argument check's to report.
  const inSource = argumentsOf(en);
  const inTarget = argumentsOf(text);
  for (const [name, original] of Object.entries(source)) {
    const target = targets[name];
    if (!(name in inTarget)) continue;
    if (!target) problems.push(`{${name}} is a ${original.kind} in en and is not one here`);
    else if (target.kind !== original.kind) {
      problems.push(`{${name}} is a ${original.kind} in en and a ${target.kind} here`);
    }
  }
  for (const [name, target] of Object.entries(targets)) {
    const original = source[name];
    if (!original) {
      if (name in inSource) {
        problems.push(`{${name}} is a ${target.kind} here and is not one in en`);
      }
      continue;
    }
    if (original.kind !== target.kind) continue; // reported above
    if (target.kind === "select") {
      const missing = [...original.options].filter((o) => !target.options.has(o));
      const extra = [...target.options].filter((o) => !original.options.has(o));
      if (missing.length > 0 || extra.length > 0) {
        problems.push(
          `{${name}} does not have the select options of en (${[
            missing.length > 0 ? `missing ${missing.join(", ")}` : "",
            extra.length > 0 ? `extra ${extra.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("; ")})`,
        );
      }
      continue;
    }
    const type = target.kind === "plural" ? "cardinal" : "ordinal";
    const needed = new Intl.PluralRules(locale, { type }).resolvedOptions().pluralCategories;
    // `=1` answers for `one`: in en, fi and sv the one-form is the number 1 alone.
    const missing = needed.filter(
      (form) => !target.options.has(form) && !(form === "one" && target.options.has("=1")),
    );
    const exact = [...original.options].filter((o) => o.startsWith("=") && !target.options.has(o));
    if (missing.length > 0) {
      problems.push(`{${name}} lacks the ${locale} plural forms ${missing.join(", ")}`);
    }
    if (exact.length > 0)
      problems.push(`{${name}} lacks the exact cases ${exact.join(", ")} of en`);
  }
  return problems;
}

// A preposition directly before a plain {value} is where English invites an
// inflected noun in Finnish ("in {pond}" has no nominative translation).
const PREPOSITION_BEFORE =
  /\b(in|at|to|from|of|on|into|with|for|by|near|without)\s+(?:(?:a|an|the)\s+)?$/i;
// A letter, or a colon and letters ("{pond}:ssa"), glued after a plain {value}.
const SUFFIX_AFTER = /^[:'’]?\p{L}/u;

/**
 * TD-17: a dynamic value never stands where the sentence inflects it. Reports
 * a plain {argument} that follows a preposition (English source) or carries a
 * glued suffix (any locale). Numbers, plurals and dates are not nouns and pass.
 */
export function inflectionProblems(message: string, locale: string): string[] {
  const problems: string[] = [];
  const visit = (elements: MessageFormatElement[]): void => {
    elements.forEach((el, i) => {
      if (el.type === TYPE.plural || el.type === TYPE.select) {
        for (const option of Object.values(el.options)) visit(option.value);
      } else if (el.type === TYPE.tag) {
        visit(el.children);
      }
      if (el.type !== TYPE.argument) return;
      const before = elements[i - 1];
      const after = elements[i + 1];
      if (
        locale === "en" &&
        before?.type === TYPE.literal &&
        PREPOSITION_BEFORE.test(before.value)
      ) {
        problems.push(
          `"${before.value.trim().split(/\s+/).pop()} {${el.value}}" puts a dynamic value where other languages inflect it`,
        );
      }
      if (after?.type === TYPE.literal && SUFFIX_AFTER.test(after.value)) {
        problems.push(`{${el.value}} has a suffix glued to it: a dynamic value is never inflected`);
      }
    });
  };
  visit(parse(message));
  return problems;
}

const ACCENTS: Record<string, string> = {
  a: "á",
  e: "é",
  i: "í",
  o: "ó",
  u: "ú",
  y: "ý",
  c: "ç",
  n: "ñ",
  s: "š",
  z: "ž",
  A: "Á",
  E: "É",
  I: "Í",
  O: "Ó",
  U: "Ú",
  Y: "Ý",
  C: "Ç",
  N: "Ñ",
  S: "Š",
  Z: "Ž",
};
const VOWEL = /[aeiouyAEIOUY]/;

function pseudoText(text: string): string {
  let out = "";
  for (const char of text) {
    out += ACCENTS[char] ?? char;
    // Every vowel doubled: about a third longer, as Finnish runs against English.
    if (VOWEL.test(char)) out += ACCENTS[char] ?? char;
  }
  return out;
}

/**
 * The en-XA pseudo-locale: accented, elongated, bracketed text with the ICU
 * structure untouched, so clipped or concatenated strings show in a dev build.
 */
export function pseudoLocalise(message: string): string {
  const transform = (elements: MessageFormatElement[]): MessageFormatElement[] =>
    elements.map((el) => {
      if (el.type === TYPE.literal) return { ...el, value: pseudoText(el.value) };
      if (el.type === TYPE.plural || el.type === TYPE.select) {
        const options = Object.fromEntries(
          Object.entries(el.options).map(([name, option]) => [
            name,
            { ...option, value: transform(option.value) },
          ]),
        );
        return { ...el, options };
      }
      if (el.type === TYPE.tag) return { ...el, children: transform(el.children) };
      return el;
    });
  return `［${printAST(transform(parse(message)))}］`;
}

/** Whether two texts use the same arguments: the same names, each of the same type. */
export function sameArguments(
  a: Record<string, ArgumentType>,
  b: Record<string, ArgumentType>,
): boolean {
  const names = Object.keys(a).sort();
  return (
    names.join() === Object.keys(b).sort().join() && names.every((name) => a[name] === b[name])
  );
}

/** Whether two texts carry the same tags: markup the app renders, kept exactly. */
export function sameTags(a: string, b: string): boolean {
  return [...tagsOf(a)].sort().join() === [...tagsOf(b)].sort().join();
}
