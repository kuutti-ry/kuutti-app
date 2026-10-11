import type { ProfileFieldKey, ProfileFields } from "@kuutti/schema";
import { fireEvent, screen } from "@testing-library/react-native";
import { useState } from "react";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { FieldEditor, optionTextKey, SpecialCategoryNote } from "./FieldEditor";

// One field of the registry as the person answers it (#47, #148, ADR-019):
// a setting as a switch, choices as chips that say whether they are chosen,
// a short text, a number as a stepper, and a search over a long list.

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock };
};

/** The draft the editor works on, as the screens hold it; `fields` is what it holds now. */
let fields: ProfileFields = {};
function Harness({ field, initial }: { field: ProfileFieldKey; initial: ProfileFields }) {
  const [draft, setDraft] = useState({ fields: initial });
  fields = draft.fields;
  return (
    <FieldEditor
      field={field}
      draft={draft}
      update={(patch) => setDraft((previous) => ({ ...previous, ...patch }))}
    />
  );
}
const show = (field: ProfileFieldKey, initial: ProfileFields = {}) =>
  renderWithTheme(<Harness field={field} initial={initial} />);
const chosen = (name: string) =>
  screen.getByRole("button", { name }).props.accessibilityState?.selected;

beforeEach(() => {
  fields = {};
  router.push.mockReset();
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

  it("takes no more than the field's limit", async () => {
    const five = ["fi", "sv", "en", "es", "de"];
    await show("languages", { languages: five } as ProfileFields);
    await fireEvent.press(screen.getByRole("button", { name: "français" }));
    expect(fields).toEqual({ languages: five });
    expect(chosen("français")).toBe(false);
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
    expect(screen.getByRole("button", { name: "suomi" })).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Search"), "  DEUT ");
    expect(screen.getByRole("button", { name: "Deutsch" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "suomi" })).toBeNull();
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
});

describe("FieldEditor: a short text", () => {
  it("keeps what is typed, says the limit, and drops the field when emptied", async () => {
    await show("occupationTitle");
    const input = screen.getByLabelText("Job title, without the employer's name");
    expect(input.props.value).toBe("");
    expect(screen.getByText("In your own words, up to 40 characters.")).toBeTruthy();
    await fireEvent.changeText(input, "Architect");
    expect(fields).toEqual({ occupationTitle: "Architect" });
    await fireEvent.changeText(input, "");
    expect(fields).toEqual({});
  });

  it("shows an empty box for a stored value that is not text", async () => {
    await show("occupationTitle", { occupationTitle: 7 } as unknown as ProfileFields);
    expect(screen.getByLabelText("Job title, without the employer's name").props.value).toBe("");
  });
});

describe("FieldEditor: a number", () => {
  it("starts unanswered, takes the middle of the range on the first press, then moves by one", async () => {
    await show("height");
    expect(screen.getByText("No answer yet")).toBeTruthy();
    expect(screen.getByText("A whole number from 140 to 220.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear the answer" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "One less" }));
    expect(fields).toEqual({ height: 180 });
    await fireEvent.press(screen.getByRole("button", { name: "One more" }));
    expect(fields).toEqual({ height: 181 });
    expect(screen.getByText("181 cm")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Clear the answer" }));
    expect(fields).toEqual({});
  });

  it("stops at either end of the range", async () => {
    await show("height", { height: 220 } as ProfileFields);
    const up = screen.getByRole("button", { name: "One more" });
    expect(up.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(screen.getByRole("button", { name: "One less" }));
    expect(fields).toEqual({ height: 219 });
  });

  it("cannot go below the lower end", async () => {
    await show("height", { height: 140 } as ProfileFields);
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

describe("SpecialCategoryNote", () => {
  it("names the consent the sensitive answers are kept under and leads to where it is withdrawn", async () => {
    await renderWithTheme(<SpecialCategoryNote />);
    expect(screen.getByText(/Stored under the sensitive-answers consent/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Settings" }));
    expect(router.push).toHaveBeenCalledWith("/settings");
  });
});
