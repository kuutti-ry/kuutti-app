import { expect } from "vitest";
import { attack } from "./attack.ts";
import { findUiStrings } from "./ui-strings.ts";

// Attacks on check:ui-strings' reading of one TSX file (#380): a string a
// person reads or hears, written inline in a form the pass may not read
// (CLAUDE.md Code: "never inline"; .claude/rules/i18n.md, the t() bullet).
// Each row is the form with an inline string, and the same form through t(),
// which the check has to pass.

const found = (source: string) => findUiStrings("probe.tsx", source).map((hit) => hit.text);

// Retained scope is explicit and tied to its decision in the #380 completion ledger.

const QUESTION = "accepted #380/2-09: no cross-statement string dataflow analysis";

/** What is tried, the form with an inline string, the same form through t(), and whether it goes through today. */
const INLINE: [string, string, string, string?][] = [
  // Between tags, as anything but a bare literal: the pass reads a literal or a
  // template that is the whole child, and nothing inside another expression.
  [
    "a string in either arm of a conditional between tags",
    '<Text>{ok ? "Yes" : "No"}</Text>',
    '<Text>{ok ? t("a.yes") : t("a.no")}</Text>',
  ],
  [
    "a string after && between tags",
    '<Text>{ok && "Done"}</Text>',
    '<Text>{ok && t("a.b")}</Text>',
  ],
  [
    "a string joined to a value with + between tags",
    '<Text>{"Hello " + name}</Text>',
    '<Text>{t("a.b") + name}</Text>',
  ],
  ["a string in brackets between tags", '<Text>{("Hello")}</Text>', '<Text>{(t("a.b"))}</Text>'],
  [
    "strings joined by a call between tags",
    '<Text>{["One", "Two"].join(", ")}</Text>',
    '<Text>{[t("a.one"), t("a.two")].join(", ")}</Text>',
  ],
  // In a prop that is read or heard, as anything but a bare literal: the same
  // reading, and a prop's name is looked for on the element's own attributes only.
  [
    "a string in a conditional in a prop that is read",
    '<Button title={busy ? "Saving" : "Save"} />',
    '<Button title={busy ? t("a.saving") : t("a.save")} />',
  ],
  [
    "a prop that is read, spread from an object",
    '<Button {...{ title: "Save" }} />',
    '<Button {...{ title: t("a.save") }} />',
  ],
  [
    "the text handed over as the children prop",
    '<Text children="Hello" />',
    '<Text children={t("a.b")} />',
  ],
  [
    "a screen's title in its options",
    '<Stack.Screen options={{ title: "Settings" }} />',
    '<Stack.Screen options={{ title: t("a.b") }} />',
  ],
  [
    "what a screen reader says of a value",
    '<View accessibilityValue={{ text: "Half full" }} />',
    '<View accessibilityValue={{ text: t("a.b") }} />',
  ],
  // A prop that is read or heard and is not among the eight the pass knows.
  ...["aria-description", "aria-valuetext", "confirmLabel", "message", "helperText"].map(
    (prop): [string, string, string, string?] => [
      `a literal in the ${prop} prop`,
      `<Thing ${prop}="Delete it" />`,
      `<Thing ${prop}={t("a.b")} />`,
    ],
  ),
  // Shown or spoken without being a JSX child or prop at all: the pass reads
  // JSX, and the rule's own words name JSX text, a JSX child and a prop.
  [
    "a string kept in a constant and shown",
    '(() => { const label = "Hello"; return <Text>{label}</Text>; })',
    '(() => { const label = t("a.b"); return <Text>{label}</Text>; })',
    QUESTION,
  ],
  [
    "the words of an alert",
    '(() => { Alert.alert("Delete?", "This cannot be undone."); return <View />; })',
    '(() => { Alert.alert(t("a.title"), t("a.body")); return <View />; })',
  ],
  [
    "what is announced to a screen reader",
    '(() => { AccessibilityInfo.announceForAccessibility("Saved"); return <View />; })',
    '(() => { AccessibilityInfo.announceForAccessibility(t("a.b")); return <View />; })',
  ],
  // Forms the pass has to read like the plain ones.
  ["text in Cyrillic between tags", "<Text>Привет</Text>", '<Text>{t("a.b")}</Text>'],
  ["text in Japanese between tags", "<Text>こんにちは</Text>", '<Text>{t("a.b")}</Text>'],
  ["text beside a translated part", '<Text>{t("a.n")} items</Text>', '<Text>{t("a.n")} · </Text>'],
  ["text in a fragment", "<>Hello</>", '<>{t("a.b")}</>'],
  [
    "text in an element handed to a prop nobody reads",
    "<Screen header={<Text>Hi</Text>} />",
    '<Screen header={<Text>{t("a.b")}</Text>} />',
  ],
  [
    "text in the element a render prop returns",
    "<List renderItem={() => <Text>Row</Text>} />",
    '<List renderItem={() => <Text>{t("a.b")}</Text>} />',
  ],
  [
    "text in the element of a conditional's arm",
    "<View>{ok ? <Text>Yes</Text> : null}</View>",
    '<View>{ok ? <Text>{t("a.b")}</Text> : null}</View>',
  ],
  [
    "a template with a gap in a prop that is heard",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: TSX under test, not a template of this file
    "<Button accessibilityLabel={`Close ${name}`} />",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: TSX under test, not a template of this file
    '<Button accessibilityLabel={`${t("a.b")} ${name}`} />',
  ],
];

for (const [name, inline, translated, open] of INLINE) {
  attack(`check:ui-strings: ${name} passes`, {
    attempt: () => found(`const a = ${inline};`),
    control: () => found(`const a = ${translated};`),
    succeeds: (seen) => expect(seen).toEqual([]),
    open,
  });
}

/** What is tried, something that is no language, and language in the same place. */
const NOT_LANGUAGE: [string, string, string, string?][] = [
  // The text between tags is read as it is written, so an entity's name counts as letters.
  ["a symbol written as a named entity", "<Text>&middot;</Text>", "<Text>middle</Text>"],
  ["a symbol written as a numbered entity", "<Text>&#183;</Text>", "<Text>dot</Text>"],
  ["a date in digits", "<Text>12.5.2026</Text>", "<Text>12 May 2026</Text>"],
  ["an emoji", "<Text>👍</Text>", "<Text>Good</Text>"],
];

for (const [name, harmless, language, open] of NOT_LANGUAGE) {
  attack(`check:ui-strings: ${name} is reported as an inline string`, {
    attempt: () => found(`const a = ${harmless};`),
    control: () => found(`const a = ${language};`),
    succeeds: (seen) => expect(seen).not.toEqual([]),
    open,
  });
}
