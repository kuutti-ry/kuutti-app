import { PROMPT_KEYS, PROMPTS_MAX, type PromptAnswer } from "@kuutti/schema";
import { fireEvent, screen } from "@testing-library/react-native";
import { useState } from "react";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { PromptsEditor } from "./PromptsEditor";

// The prompts (#47, ADR-009 §4): the answered ones with their text and a way
// to remove each, and the ones still to pick while fewer than three are taken.

let prompts: PromptAnswer[] = [];
function Harness({ initial }: { initial: PromptAnswer[] }) {
  const [draft, setDraft] = useState({ prompts: initial });
  prompts = draft.prompts;
  return <PromptsEditor draft={draft} update={(patch) => setDraft(patch)} />;
}
const show = (initial: PromptAnswer[] = []) => renderWithTheme(<Harness initial={initial} />);

describe("PromptsEditor", () => {
  it("offers every prompt while none is taken, and adds the one picked with an empty answer", async () => {
    await show();
    // How many of three hold an answer, and no heading of its own: the screen's names the prompts (#239).
    expect(screen.getByLabelText(`0 of ${PROMPTS_MAX} answered`)).toBeTruthy();
    expect(screen.getByText(`0/${PROMPTS_MAX}`)).toBeTruthy();
    expect(screen.queryByText("Prompts")).toBeNull();
    expect(screen.getByText("Add a prompt")).toBeTruthy();
    expect(
      screen.getAllByRole("button").filter((b) => b.props.accessibilityState?.selected === false),
    ).toHaveLength(PROMPT_KEYS.length);
    await fireEvent.press(screen.getByRole("button", { name: "My ideal Sunday" }));
    expect(prompts).toEqual([{ key: "sunday", answer: "" }]);
    // The picked prompt is no longer offered; its answer box is.
    expect(screen.queryByRole("button", { name: "My ideal Sunday" })).toBeNull();
    expect(screen.getByLabelText("Your answer to: My ideal Sunday")).toBeTruthy();
  });

  it("writes the answer to its own prompt only, and counts it once it holds more than blanks", async () => {
    await show([
      { key: "sunday", answer: "" },
      { key: "hidden_talent", answer: "Whistling." },
    ]);
    expect(screen.getByText("1/3")).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Your answer to: My ideal Sunday"), "  ");
    expect(screen.getByText("1/3")).toBeTruthy();
    await fireEvent.changeText(
      screen.getByLabelText("Your answer to: My ideal Sunday"),
      "A long breakfast.",
    );
    expect(prompts).toEqual([
      { key: "sunday", answer: "A long breakfast." },
      { key: "hidden_talent", answer: "Whistling." },
    ]);
    expect(screen.getByText("2/3")).toBeTruthy();
    expect(pressables(screen.toJSON() as HostNode).flatMap((n) => a11yProblems(n))).toEqual([]);
  });

  it("removes a prompt with its answer", async () => {
    await show([
      { key: "sunday", answer: "A long breakfast." },
      { key: "hidden_talent", answer: "Whistling." },
    ]);
    await fireEvent.press(
      screen.getByRole("button", { name: "Remove the prompt: My hidden talent" }),
    );
    expect(prompts).toEqual([{ key: "sunday", answer: "A long breakfast." }]);
    expect(screen.getByRole("button", { name: "My hidden talent" })).toBeTruthy();
  });

  it("offers nothing more to pick once three are taken", async () => {
    const three = PROMPT_KEYS.slice(0, PROMPTS_MAX).map((key) => ({ key, answer: "x" }));
    await show(three);
    expect(screen.queryByText("Add a prompt")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Remove the prompt/ })).toHaveLength(PROMPTS_MAX);
  });
});
