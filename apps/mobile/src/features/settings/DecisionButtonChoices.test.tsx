import { fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { DecisionButtonChoices } from "./DecisionButtonChoices";

// Like and Pass in their Settings row (#82, #511): the two hands as a labelled
// radio group, the one-handed switch, the marks they carry as a radio group of
// their own (#520), named in sight over them and with no other line (#581),
// every control labelled and 44 pt, each change kept on the phone.

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const KEY = "kuutti.preference.decisionButtons";
const stored = () => JSON.parse(store.get(KEY) ?? "null") as Record<string, unknown> | null;
const chosen = (name: RegExp) =>
  screen.getByRole("radio", { name }).props.accessibilityState.checked as boolean;
const oneHanded = () =>
  screen.getByRole("switch", { name: "One-handed" }).props.accessibilityState.checked as boolean;
/** Every text on the screen, in order. */
const drawn = () => screen.queryAllByText(/./).map((node) => node.props.children);

beforeEach(() => {
  store.clear();
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
});

describe("the decision buttons' choices", () => {
  it("offers the two hands with the right chosen, and one-handed off, with no sentence or hint (#581)", async () => {
    await renderWithTheme(<DecisionButtonChoices />);
    expect(screen.getByLabelText("Which hand").props.accessibilityRole).toBe("radiogroup");
    expect(chosen(/Right hand/)).toBe(true);
    expect(chosen(/Left hand/)).toBe(false);
    expect(oneHanded()).toBe(false);
    expect(drawn()).toEqual([
      "✓ Right hand",
      "Left hand",
      "One-handed",
      "Button style",
      "✓ Kuutti",
      "✕ and ○",
      "A and B",
    ]);
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    // The two hands, the switch and the three styles.
    expect(found).toHaveLength(6);
  });

  it("keeps each change on the phone, from the choices, the switch and its words", async () => {
    await renderWithTheme(<DecisionButtonChoices />);
    await fireEvent.press(screen.getByRole("radio", { name: /Left hand/ }));
    await waitFor(() =>
      expect(stored()).toEqual({ hand: "left", oneHanded: false, style: "kuutti" }),
    );
    expect(chosen(/Left hand/)).toBe(true);
    await fireEvent.press(screen.getByRole("switch", { name: "One-handed" }));
    await waitFor(() =>
      expect(stored()).toEqual({ hand: "left", oneHanded: true, style: "kuutti" }),
    );
    expect(oneHanded()).toBe(true);
    await fireEvent.press(screen.getByText("One-handed"));
    await waitFor(() => expect(stored()?.oneHanded).toBe(false));
    await fireEvent.press(screen.getByRole("radio", { name: /Right hand/ }));
    await waitFor(() =>
      expect(stored()).toEqual({ hand: "right", oneHanded: false, style: "kuutti" }),
    );
  });

  it("starts from what the phone holds", async () => {
    store.set(KEY, JSON.stringify({ hand: "left", oneHanded: true, style: "letters" }));
    await renderWithTheme(<DecisionButtonChoices />);
    await waitFor(() => expect(chosen(/Left hand/)).toBe(true));
    expect(oneHanded()).toBe(true);
    expect(chosen(/A and B/)).toBe(true);
    expect(chosen(/^(✓ )?Kuutti$/)).toBe(false);
  });

  it("offers the styles as a group of their own, Kuutti's chosen, with its name in sight over them (#581)", async () => {
    await renderWithTheme(<DecisionButtonChoices />);
    const group = screen.getByLabelText("Button style");
    expect(group.props.accessibilityRole).toBe("radiogroup");
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    expect(chosen(/^(✓ )?Kuutti$/)).toBe(true);
    expect(chosen(/Cross and circle/)).toBe(false);
    expect(chosen(/A and B/)).toBe(false);
    // Not only for a screen reader, which hears the group's name.
    const lines = drawn();
    expect(lines.indexOf("Button style")).toBe(lines.indexOf("✓ Kuutti") - 1);
  });

  it("keeps each style on the phone beside the hand, and back to Kuutti's own", async () => {
    store.set(KEY, JSON.stringify({ hand: "left", oneHanded: true }));
    await renderWithTheme(<DecisionButtonChoices />);
    await waitFor(() => expect(chosen(/Left hand/)).toBe(true));
    await fireEvent.press(screen.getByRole("radio", { name: /Cross and circle/ }));
    await waitFor(() =>
      expect(stored()).toEqual({ hand: "left", oneHanded: true, style: "shapes" }),
    );
    expect(chosen(/Cross and circle/)).toBe(true);
    expect(chosen(/^(✓ )?Kuutti$/)).toBe(false);
    await fireEvent.press(screen.getByRole("radio", { name: /A and B/ }));
    await waitFor(() => expect(stored()?.style).toBe("letters"));
    await fireEvent.press(screen.getByRole("radio", { name: /^(✓ )?Kuutti$/ }));
    await waitFor(() =>
      expect(stored()).toEqual({ hand: "left", oneHanded: true, style: "kuutti" }),
    );
  });

  it.each([
    ["en-US", "✕ and ○", "Cross and circle", "A and B", "Button style"],
    ["fi-FI", "✕ ja ○", "Risti ja ympyrä", "A ja B", "Painikkeiden tyyli"],
    ["sv-FI", "✕ och ○", "Kryss och cirkel", "A och B", "Knappstil"],
  ])(
    "shows the shapes as marks and says them in words, in %s",
    async (languageTag, shown, heard, letters, style) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
      store.set(KEY, JSON.stringify({ style: "shapes" }));
      await renderWithTheme(<DecisionButtonChoices />);
      // Chosen, the ✓ is in the words a screen reader hears as well as in those on the button.
      expect(await screen.findByText(`✓ ${shown}`)).toBeTruthy();
      expect(screen.getByRole("radio", { name: `✓ ${heard}` })).toBeTruthy();
      expect(screen.getByRole("radio", { name: letters })).toBeTruthy();
      expect(screen.getByText(letters)).toBeTruthy();
      expect(screen.getByText(style)).toBeTruthy();
      expect(screen.getByLabelText(style).props.accessibilityRole).toBe("radiogroup");
      // The setting names no console (#520, .claude/rules/mobile.md).
      expect(JSON.stringify(screen.toJSON())).not.toMatch(/playstation|xbox|nintendo|sony/i);
    },
  );
});
