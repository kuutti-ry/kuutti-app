import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { DecisionButtonChoices } from "./DecisionButtonChoices";

// The decision buttons in their Settings row (#82, #511): the two hands as a
// labelled radio group, the one-handed switch with what it does, every
// control labelled and 44 pt, each change kept on the phone.

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const KEY = "kuutti.preference.decisionButtons";
const stored = () => JSON.parse(store.get(KEY) ?? "null") as Record<string, unknown> | null;
const chosen = (name: RegExp) =>
  screen.getByRole("radio", { name }).props.accessibilityState.checked as boolean;
const oneHanded = () =>
  screen.getByRole("switch", { name: "One-handed" }).props.accessibilityState.checked as boolean;

beforeEach(() => store.clear());

describe("the decision buttons' choices", () => {
  it("says what it moves, offers the two hands with the right chosen, and one-handed off", async () => {
    await renderWithTheme(<DecisionButtonChoices />);
    expect(screen.getByText(/^Where Like and Pass sit on today's round/)).toBeTruthy();
    expect(screen.getByLabelText("Which hand").props.accessibilityRole).toBe("radiogroup");
    expect(chosen(/Right hand/)).toBe(true);
    expect(chosen(/Left hand/)).toBe(false);
    expect(oneHanded()).toBe(false);
    expect(screen.getByText(/^Undo, the fish, Pass and Like in one column/)).toBeTruthy();
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    // The two hands and the switch.
    expect(found).toHaveLength(3);
  });

  it("keeps each change on the phone, from the choices, the switch and its words", async () => {
    await renderWithTheme(<DecisionButtonChoices />);
    await fireEvent.press(screen.getByRole("radio", { name: /Left hand/ }));
    await waitFor(() => expect(stored()).toEqual({ hand: "left", oneHanded: false }));
    expect(chosen(/Left hand/)).toBe(true);
    await fireEvent.press(screen.getByRole("switch", { name: "One-handed" }));
    await waitFor(() => expect(stored()).toEqual({ hand: "left", oneHanded: true }));
    expect(oneHanded()).toBe(true);
    await fireEvent.press(screen.getByText("One-handed"));
    await waitFor(() => expect(stored()?.oneHanded).toBe(false));
    await fireEvent.press(screen.getByRole("radio", { name: /Right hand/ }));
    await waitFor(() => expect(stored()).toEqual({ hand: "right", oneHanded: false }));
  });

  it("starts from what the phone holds", async () => {
    store.set(KEY, JSON.stringify({ hand: "left", oneHanded: true }));
    await renderWithTheme(<DecisionButtonChoices />);
    await waitFor(() => expect(chosen(/Left hand/)).toBe(true));
    expect(oneHanded()).toBe(true);
  });
});
