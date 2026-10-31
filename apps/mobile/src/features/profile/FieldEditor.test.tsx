import type { HiddenField, ProfileFieldKey, ProfileFields } from "@kuutti/schema";
import { fireEvent, screen } from "@testing-library/react-native";
import { useState } from "react";
import { AccessibilityInfo } from "react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { FieldEditor, optionTextKey, toggled, visibleOptions } from "./FieldEditor";

// One field of the registry as the person answers it (#47, #148, ADR-019):
// a setting as a switch, choices as chips that say whether they are chosen,
// a short text, a number as a stepper, and a search over a long list.

/** The draft the editor works on, as the screens hold it; `fields` is what it holds now. */
let fields: ProfileFields = {};
let hiddenFields: readonly HiddenField[] | undefined;
function Harness({
  field,
  initial,
  hidden,
}: {
  field: ProfileFieldKey;
  initial: ProfileFields;
  hidden?: HiddenField[];
}) {
  const [draft, setDraft] = useState<{ fields: ProfileFields; hiddenFields?: HiddenField[] }>({
    fields: initial,
    hiddenFields: hidden,
  });
  fields = draft.fields;
  hiddenFields = draft.hiddenFields;
  return (
    <FieldEditor
      field={field}
      draft={draft}
      update={(patch) => setDraft((previous) => ({ ...previous, ...patch }))}
    />
  );
}
const show = (field: ProfileFieldKey, initial: ProfileFields = {}, hidden?: HiddenField[]) =>
  renderWithTheme(<Harness field={field} initial={initial} hidden={hidden} />);
const chosen = (name: string) =>
  screen.getByRole("button", { name }).props.accessibilityState?.selected;

beforeEach(() => {
  fields = {};
  hiddenFields = undefined;
});

describe("FieldEditor: a setting", () => {
  it("is a labelled switch that sets the flag, and takes it away again when turned off", async () => {
    await show("hideFromField");
    const toggle = screen.getByRole("switch", { name: "Hide me from people in my field" });
    expect(toggle.props.accessibilityState).toMatchObject({ checked: false });
    await fireEvent.press(toggle);
    expect(fields).toEqual({ hideFromField: true });
    await fireEvent.press(screen.getByRole("switch", { name: "Hide me from people in my field" }));
    expect(fields).toEqual({});
  });
});

describe("FieldEditor: what the card shows (#515)", () => {
  const HIDE_SMOKING = "Hide from your card: Smoking";
  const SHOW_SMOKING = "Show on your card: Smoking";
  const USED = "Hidden from your card. Still used for matching.";
  const NOT_USED = "Hidden from your card.";

  afterEach(() => jest.restoreAllMocks());

  it("offers nothing on an unanswered field", async () => {
    await show("smoking");
    expect(screen.queryByRole("button", { name: HIDE_SMOKING })).toBeNull();
    expect(screen.queryByText(USED)).toBeNull();
  });

  it("offers Hide once there is an answer, with no line under the title", async () => {
    await show("smoking");
    await fireEvent.press(screen.getByRole("button", { name: "Never" }));
    expect(screen.getByRole("button", { name: HIDE_SMOKING })).toBeTruthy();
    expect(screen.getByText("Hide")).toBeTruthy();
    expect(screen.queryByText(USED)).toBeNull();
  });

  it("hides the answer and keeps it, says what that means, and turns into Show", async () => {
    const said = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
    await show("smoking", { smoking: "never" });
    await fireEvent.press(screen.getByRole("button", { name: HIDE_SMOKING }));
    expect(hiddenFields).toEqual(["smoking"]);
    expect(fields).toEqual({ smoking: "never" });
    expect(screen.getByText(USED)).toBeTruthy();
    expect(screen.getByText("Show")).toBeTruthy();
    expect(chosen("Never")).toBe(true);
    expect(said).toHaveBeenCalledWith(USED);
  });

  it("shows a hidden answer again, the rest of the set as it was", async () => {
    const said = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
    await show("smoking", { smoking: "never" }, ["height", "smoking"]);
    await fireEvent.press(screen.getByRole("button", { name: SHOW_SMOKING }));
    expect(hiddenFields).toEqual(["height"]);
    expect(screen.getByRole("button", { name: HIDE_SMOKING })).toBeTruthy();
    expect(screen.queryByText(USED)).toBeNull();
    expect(said).toHaveBeenCalledWith("Back on your card.");
  });

  it.each([
    ["intent", { intent: "casual" }, USED],
    ["languages", { languages: ["fi"] }, USED],
    ["monogamy", { monogamy: "monogamous" }, USED],
    ["hobbies", { hobbies: ["sauna"] }, NOT_USED],
    ["height", { height: 171 }, NOT_USED],
    ["politics", { politics: ["vas"] }, NOT_USED],
    ["religion", { religion: "atheist" }, NOT_USED],
    ["occupationTitle", { occupationTitle: "Nurse" }, NOT_USED],
  ] satisfies [ProfileFieldKey, ProfileFields, string][])(
    "says matching still reads a hidden %s only where it does",
    async (field, initial, line) => {
      await show(field, initial, [field]);
      expect(screen.getByText(line)).toBeTruthy();
      expect(screen.queryByText(line === USED ? NOT_USED : USED)).toBeNull();
    },
  );

  it.each([
    ["education", { education: "amk" }],
    ["drinking", {}],
    ["drugsAttitude", { drugsAttitude: "not_my_thing" }],
  ] as const)(
    "says %s is never on a card, answered or not, with nothing to hide",
    async (field, initial) => {
      await show(field, initial);
      expect(screen.getByText("Never on your card. Only used for matching.")).toBeTruthy();
      expect(screen.queryByText("Hide")).toBeNull();
    },
  );

  it("leaves a setting as it was: no Hide and no line", async () => {
    await show("hideFromField", { hideFromField: true });
    expect(screen.queryByText("Hide")).toBeNull();
    expect(screen.queryByText("Never on your card. Only used for matching.")).toBeNull();
  });

  it("says a field of study is hidden under the setting, with nothing to press", async () => {
    await show("field", { field: ["tech"], hideFromField: true });
    expect(screen.getByText(NOT_USED)).toBeTruthy();
    expect(screen.queryByText("Hide")).toBeNull();
    expect(screen.queryByText("Show")).toBeNull();
  });

  it("offers Hide on a field of study again without the setting", async () => {
    await show("field", { field: ["tech"] });
    expect(screen.getByText("Hide")).toBeTruthy();
    expect(screen.queryByText(NOT_USED)).toBeNull();
  });

  it("keeps a cleared answer's place in the set: answered again, it is hidden again, and says so", async () => {
    await show("smoking", { smoking: "never" }, ["smoking"]);
    await fireEvent.press(screen.getByRole("button", { name: "Never" }));
    expect(fields).toEqual({});
    expect(hiddenFields).toEqual(["smoking"]);
    expect(screen.queryByText(USED)).toBeNull();
    expect(screen.queryByText("Show")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Sometimes" }));
    expect(screen.getByText(USED)).toBeTruthy();
    expect(screen.getByRole("button", { name: SHOW_SMOKING })).toBeTruthy();
  });

  it("starts the hidden set from nothing on a draft that has none", async () => {
    await show("height", { height: 171 });
    expect(hiddenFields).toBeUndefined();
    await fireEvent.press(screen.getByRole("button", { name: "Hide from your card: Height" }));
    expect(hiddenFields).toEqual(["height"]);
  });

  it("offers it on a short text too", async () => {
    await show("occupationTitle", { occupationTitle: "Nurse" });
    expect(screen.getByRole("button", { name: "Hide from your card: Job title" })).toBeTruthy();
  });

  it("is a labelled button with a 44 pt target, in both states", async () => {
    await show("smoking", { smoking: "never" });
    expect(pressables(screen.toJSON() as HostNode).flatMap((n) => a11yProblems(n))).toEqual([]);
    await fireEvent.press(screen.getByRole("button", { name: HIDE_SMOKING }));
    expect(pressables(screen.toJSON() as HostNode).flatMap((n) => a11yProblems(n))).toEqual([]);
  });
});

describe("FieldEditor: one choice", () => {
  it("chooses an option, changes it, and clears it when the chosen one is pressed again", async () => {
    await show("smoking");
    expect(screen.getByText("Smoking")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Never" }));
    expect(fields).toEqual({ smoking: "never" });
    expect(chosen("Never")).toBe(true);
    await fireEvent.press(screen.getByRole("button", { name: "Sometimes" }));
    expect(fields).toEqual({ smoking: "sometimes" });
    expect(chosen("Never")).toBe(false);
    await fireEvent.press(screen.getByRole("button", { name: "Sometimes" }));
    expect(fields).toEqual({});
    expect(pressables(screen.toJSON() as HostNode).flatMap((n) => a11yProblems(n))).toEqual([]);
  });
});

describe("FieldEditor: several choices", () => {
  it("adds and removes options, and drops the field when the last one goes", async () => {
    await show("pets");
    await fireEvent.press(screen.getByRole("button", { name: "Dog" }));
    await fireEvent.press(screen.getByRole("button", { name: "Cat" }));
    expect(fields).toEqual({ pets: ["dog", "cat"] });
    await fireEvent.press(screen.getByRole("button", { name: "Dog" }));
    expect(fields).toEqual({ pets: ["cat"] });
    await fireEvent.press(screen.getByRole("button", { name: "Cat" }));
    expect(fields).toEqual({});
  });

  it("takes as many as one likes: a sixth language and a fourth line of work join (#239)", async () => {
    const five = ["fi", "sv", "en", "es", "de"];
    await show("languages", { languages: five } as ProfileFields);
    await fireEvent.changeText(screen.getByLabelText("Search"), "fren");
    await fireEvent.press(screen.getByRole("button", { name: "French" }));
    expect(fields).toEqual({ languages: [...five, "fr"] });
    expect(chosen("French")).toBe(true);
  });

  it("takes every hobby across the groups, with no cap (#239)", async () => {
    const many = ["hiking", "gym", "cooking", "reading", "board_games", "sauna"];
    await show("hobbies", { hobbies: many } as ProfileFields);
    await fireEvent.press(screen.getByRole("button", { name: "Yoga" }));
    expect(fields).toEqual({ hobbies: [...many, "yoga"] });
  });

  it("lets 'None of them' stand alone: it clears the parties, and a party clears it (#239)", async () => {
    await show("politics", { politics: ["kok", "vihr"] } as ProfileFields);
    await fireEvent.press(screen.getByRole("button", { name: "None of them" }));
    expect(fields).toEqual({ politics: ["none_of_them"] });
    expect(chosen("National Coalition Party")).toBe(false);
    expect(chosen("None of them")).toBe(true);
    await fireEvent.press(screen.getByRole("button", { name: "Greens" }));
    expect(fields).toEqual({ politics: ["vihr"] });
    expect(chosen("None of them")).toBe(false);
    await fireEvent.press(screen.getByRole("button", { name: "Greens" }));
    expect(fields).toEqual({});
  });

  it("lets 'No snus or pouches' stand alone, and takes snus and pouches together (#239)", async () => {
    await show("nicotine");
    await fireEvent.press(screen.getByRole("button", { name: "Snus" }));
    await fireEvent.press(screen.getByRole("button", { name: "Nicotine pouches" }));
    expect(fields).toEqual({ nicotine: ["snus", "pouches"] });
    await fireEvent.press(screen.getByRole("button", { name: "No snus or pouches" }));
    expect(fields).toEqual({ nicotine: ["none"] });
    await fireEvent.press(screen.getByRole("button", { name: "Snus" }));
    expect(fields).toEqual({ nicotine: ["snus"] });
  });

  it("offers vaping among the ways of smoking (#239)", async () => {
    await show("smoking");
    await fireEvent.press(screen.getByRole("button", { name: "Vaping" }));
    expect(fields).toEqual({ smoking: "vaping" });
  });

  it("offers non-religious among the stances, between spiritual and agnostic (#509)", async () => {
    await show("religion");
    const stances = screen.getAllByText(/^(Spiritual|Non-religious|Agnostic)$/);
    expect(stances.map((chip) => chip.props.children)).toEqual([
      "Spiritual",
      "Non-religious",
      "Agnostic",
    ]);
    await fireEvent.press(screen.getByRole("button", { name: "Non-religious" }));
    expect(fields).toEqual({ religion: "non_religious" });
  });

  it("no longer offers the coffee party (#239)", async () => {
    await show("politics");
    expect(screen.queryByRole("button", { name: "The Coffee Party" })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(11);
  });

  it("puts a glyph before a party's name and still names the button by the party alone", async () => {
    await show("politics");
    const party = screen.getByRole("button", { name: "National Coalition Party" });
    expect(party.props.accessibilityLabel).toBe("National Coalition Party");
    await fireEvent.press(party);
    expect(fields).toEqual({ politics: ["kok"] });
  });
});

describe("FieldEditor: a long list", () => {
  it("offers a search that narrows the chips to the matching ones", async () => {
    await show("languages");
    expect(screen.getByRole("button", { name: "Finnish" })).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Search"), "  GERM ");
    expect(screen.getByRole("button", { name: "German" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Finnish" })).toBeNull();
  });

  it("shows the hobbies in their groups, hides a group with no match, and keeps something else apart", async () => {
    await show("hobbies");
    expect(screen.getByText("Outdoors")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Something else" })).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Search"), "yoga");
    expect(screen.getByRole("button", { name: "Yoga" })).toBeTruthy();
    expect(screen.queryByText("Outdoors")).toBeNull();
    expect(screen.queryByRole("button", { name: "Something else" })).toBeNull();
    await fireEvent.changeText(screen.getByLabelText("Search"), "something");
    expect(screen.getByRole("button", { name: "Something else" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yoga" })).toBeNull();
  });

  it("offers no search over a short list", async () => {
    await show("smoking");
    expect(screen.queryByLabelText("Search")).toBeNull();
  });

  it.each([
    ["zodiac", "Corgi"],
    ["politics", "None of them"],
    ["field", "Other"],
  ] as const)(
    "offers no search over the %s, whose every option fits a screen (#239)",
    async (field, last) => {
      await show(field);
      expect(screen.queryByLabelText("Search")).toBeNull();
      expect(screen.getByRole("button", { name: last })).toBeTruthy();
    },
  );

  it("leads the languages with ten, keeps the chosen and 'other' in view, and finds the rest by search (#239)", async () => {
    await show("languages", { languages: ["de"] } as ProfileFields);
    for (const name of [
      "Finnish",
      "Swedish",
      "English",
      "Russian",
      "Somali",
      "German",
      "Another language",
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    // Vietnamese is eleventh: found by search only.
    expect(screen.queryByRole("button", { name: "Vietnamese" })).toBeNull();
    expect(screen.queryByRole("button", { name: "French" })).toBeNull();
    await fireEvent.changeText(screen.getByLabelText("Search"), "viet");
    await fireEvent.press(screen.getByRole("button", { name: "Vietnamese" }));
    expect(fields).toEqual({ languages: ["de", "vi"] });
    // Chosen, it stays in view once the search is emptied.
    await fireEvent.changeText(screen.getByLabelText("Search"), "");
    expect(chosen("Vietnamese")).toBe(true);
    expect(screen.queryByRole("button", { name: "French" })).toBeNull();
  });

  it("keeps a language beyond the first ten in view once taken back, so it can be chosen again (#239)", async () => {
    await show("languages", { languages: ["fi", "de"] } as ProfileFields);
    await fireEvent.press(screen.getByRole("button", { name: "German" }));
    expect(fields).toEqual({ languages: ["fi"] });
    expect(chosen("German")).toBe(false);
    await fireEvent.press(screen.getByRole("button", { name: "German" }));
    expect(fields).toEqual({ languages: ["fi", "de"] });
  });
});

describe("visibleOptions", () => {
  const text = (option: string) => `Text of ${option}`;

  it("shows every option of a list that names no first ones, and filters any list by its texts", () => {
    expect(visibleOptions(["a", "b", "c"], undefined, [], "", text)).toEqual(["a", "b", "c"]);
    expect(visibleOptions(["a", "b", "c"], undefined, [], "  OF B ", text)).toEqual(["b"]);
    expect(visibleOptions(["a", "b", "other"], 1, ["b"], "of a", text)).toEqual(["a"]);
    expect(visibleOptions(["a", "b"], undefined, [], "nothing", text)).toEqual([]);
  });

  it("shows the first ones, the chosen and 'other' of a list that names first ones", () => {
    expect(visibleOptions(["a", "b", "c", "d", "other"], 2, ["d"], "", text)).toEqual([
      "a",
      "b",
      "d",
      "other",
    ]);
    expect(visibleOptions(["a", "b", "c"], 0, [], " ", text)).toEqual([]);
  });
});

describe("toggled", () => {
  const spec = { alone: ["none"] };

  it("adds any option, as many as one likes, and takes a chosen one away", () => {
    expect(toggled([], "a", spec)).toEqual(["a"]);
    expect(toggled(["a"], "b", spec)).toEqual(["a", "b"]);
    expect(toggled(["a", "b", "c"], "d", spec)).toEqual(["a", "b", "c", "d"]);
    expect(toggled(["a", "b"], "a", spec)).toEqual(["b"]);
  });

  it("lets an option that stands alone replace the rest, and gives way to any other", () => {
    expect(toggled(["a", "b", "c"], "none", spec)).toEqual(["none"]);
    expect(toggled(["none"], "a", spec)).toEqual(["a"]);
    expect(toggled(["none"], "none", spec)).toEqual([]);
    expect(toggled(["a"], "b", { alone: [] })).toEqual(["a", "b"]);
  });
});

describe("FieldEditor: a short text", () => {
  it("keeps what is typed, says the limit, and drops the field when emptied", async () => {
    await show("occupationTitle");
    const input = screen.getByLabelText("Job title");
    expect(input.props.value).toBe("");
    expect(screen.getByText("Without the employer's name, and up to 40 characters.")).toBeTruthy();
    await fireEvent.changeText(input, "Architect");
    expect(fields).toEqual({ occupationTitle: "Architect" });
    await fireEvent.changeText(input, "");
    expect(fields).toEqual({});
  });

  it("shows an empty box for a stored value that is not text", async () => {
    await show("occupationTitle", { occupationTitle: 7 } as unknown as ProfileFields);
    expect(screen.getByLabelText("Job title").props.value).toBe("");
  });
});

describe("FieldEditor: a number", () => {
  it("starts unanswered, takes the middle of the range on the first press, then moves by one", async () => {
    await show("height");
    expect(screen.getByText("No answer yet")).toBeTruthy();
    // No line under the stepper about the range (#287): its ends say where it stops.
    expect(screen.queryByText(/whole number/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear the answer" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "One less" }));
    expect(fields).toEqual({ height: 175 });
    await fireEvent.press(screen.getByRole("button", { name: "One more" }));
    expect(fields).toEqual({ height: 176 });
    expect(screen.getByText("176 cm")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Clear the answer" }));
    expect(fields).toEqual({});
  });

  it("names the field once: its own label, not the stepper's again (#238)", async () => {
    await show("height", { height: 170 } as ProfileFields);
    expect(screen.getAllByText("Height")).toHaveLength(1);
    // The one kept is the field's own, with its icon, as every other field has it.
    expect(screen.getByTestId("field-icon-height", { includeHiddenElements: true })).toBeTruthy();
  });

  it("stops at either end of the range", async () => {
    await show("height", { height: 260 } as ProfileFields);
    const up = screen.getByRole("button", { name: "One more" });
    expect(up.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(screen.getByRole("button", { name: "One less" }));
    expect(fields).toEqual({ height: 259 });
  });

  it("cannot go below the lower end", async () => {
    await show("height", { height: 90 } as ProfileFields);
    expect(
      screen.getByRole("button", { name: "One less" }).props.accessibilityState?.disabled,
    ).toBe(true);
  });
});

describe("optionTextKey", () => {
  it("reads the wants-kids options as more children once there are kids", () => {
    expect(optionTextKey("wantsKids", "want", {})).toBe("profile.option.wantsKids.want");
    expect(optionTextKey("wantsKids", "want", { hasKids: "no" } as ProfileFields)).toBe(
      "profile.option.wantsKids.want",
    );
    expect(optionTextKey("wantsKids", "want", { hasKids: "yes_with_me" } as ProfileFields)).toBe(
      "profile.optionWithKids.wantsKids.want",
    );
    expect(optionTextKey("smoking", "never", { hasKids: "yes_with_me" } as ProfileFields)).toBe(
      "profile.option.smoking.never",
    );
  });
});
