import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { PhotoDescriptionChoices } from "./PhotoDescriptionChoices";

// The photo descriptions in their Settings row (#296 part 3, #511): one
// switch for the text under the photos and three for what is told, every one
// labelled and 44 pt, each change kept on the device.

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const KEY = "kuutti.preference.photoDescriptions";
const stored = () => JSON.parse(store.get(KEY) ?? "null") as Record<string, boolean> | null;
const checked = (name: string) =>
  screen.getByRole("switch", { name }).props.accessibilityState.checked as boolean;

beforeEach(() => store.clear());

describe("the photo descriptions' choices", () => {
  it("says that a description is automatic and can be wrong, and holds four labelled switches, the text off and the three parts on by default (#581)", async () => {
    await renderWithTheme(<PhotoDescriptionChoices />);
    // One line: no hint under Show under photos, whose name says it.
    expect(screen.queryAllByText(/./).map((node) => node.props.children)).toEqual([
      "The description is automatic and can be wrong.",
      "Show under photos",
      "Tell me about",
      "People and setting",
      "Face",
      "Activity and objects",
    ]);
    expect(screen.getByRole("heading", { name: "Tell me about" })).toBeTruthy();
    expect(checked("Show under photos")).toBe(false);
    for (const part of ["People and setting", "Face", "Activity and objects"]) {
      expect(checked(part)).toBe(true);
    }
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    // The four switches; the labels beside them are not elements of their own.
    expect(found).toHaveLength(4);
  });

  it("keeps each change on the device, from the switch and from its words", async () => {
    await renderWithTheme(<PhotoDescriptionChoices />);
    await fireEvent.press(screen.getByRole("switch", { name: "Show under photos" }));
    await waitFor(() =>
      expect(stored()).toEqual({ shown: true, people: true, face: true, objects: true }),
    );
    expect(checked("Show under photos")).toBe(true);
    await fireEvent.press(screen.getByText("Face"));
    await waitFor(() => expect(stored()?.face).toBe(false));
    expect(checked("Face")).toBe(false);
    await fireEvent.press(screen.getByText("Face"));
    await waitFor(() => expect(stored()?.face).toBe(true));
    await fireEvent.press(screen.getByRole("switch", { name: "Activity and objects" }));
    await waitFor(() =>
      expect(stored()).toEqual({ shown: true, people: true, face: true, objects: false }),
    );
  });

  it("starts from what the device holds", async () => {
    store.set(KEY, JSON.stringify({ shown: true, people: false }));
    await renderWithTheme(<PhotoDescriptionChoices />);
    await waitFor(() => expect(checked("Show under photos")).toBe(true));
    expect(checked("People and setting")).toBe(false);
    expect(checked("Face")).toBe(true);
    expect(checked("Activity and objects")).toBe(true);
  });

  it("speaks Finnish and Swedish", async () => {
    store.set("kuutti.preference.locale", "fi");
    await renderWithTheme(<PhotoDescriptionChoices />);
    expect(await screen.findByRole("switch", { name: "Näytä kuvien alla" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Kasvot" })).toBeTruthy();
    expect(screen.getByText("Kuvaus on automaattinen ja voi olla väärässä.")).toBeTruthy();
    store.set("kuutti.preference.locale", "sv");
    await renderWithTheme(<PhotoDescriptionChoices />);
    expect(await screen.findByRole("switch", { name: "Visa under fotona" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Aktivitet och föremål" })).toBeTruthy();
    expect(screen.getByText("Beskrivningen är automatisk och kan ha fel.")).toBeTruthy();
  });
});
