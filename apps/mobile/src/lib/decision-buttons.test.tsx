import { act, render, renderHook, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import type * as React from "react";
import {
  DEFAULT_DECISION_BUTTONS,
  DecisionButtonsProvider,
  readDecisionButtons,
  useDecisionButtons,
} from "./decision-buttons";

// Where the round's decision buttons sit (#82): what is stored and read back,
// and the defaults where nothing or nonsense is stored.

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const KEY = "kuutti.preference.decisionButtons";
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <DecisionButtonsProvider>{children}</DecisionButtonsProvider>
);

beforeEach(() => store.clear());

describe("readDecisionButtons", () => {
  it.each([
    ["nothing", null],
    ["not JSON", "{right"],
    ["no object", "[1]"],
    ["null", "null"],
    ["a number", "7"],
  ])(
    "is the default where %s is stored: the right hand, not one-handed, Kuutti's own marks",
    (_what, raw) => {
      expect(readDecisionButtons(raw)).toEqual({
        hand: "right",
        oneHanded: false,
        style: "kuutti",
      });
    },
  );

  it("takes each known value and the default for the rest", () => {
    expect(readDecisionButtons(JSON.stringify({ hand: "left" }))).toEqual({
      hand: "left",
      oneHanded: false,
      style: "kuutti",
    });
    expect(readDecisionButtons(JSON.stringify({ oneHanded: true }))).toEqual({
      hand: "right",
      oneHanded: true,
      style: "kuutti",
    });
    expect(readDecisionButtons(JSON.stringify({ hand: "middle", oneHanded: "yes" }))).toEqual(
      DEFAULT_DECISION_BUTTONS,
    );
  });

  // A phone that chose its hand before #520 holds no style at all.
  it.each(["kuutti", "shapes", "letters"] as const)("reads the style %s", (style) => {
    expect(readDecisionButtons(JSON.stringify({ hand: "left", style }))).toEqual({
      hand: "left",
      oneHanded: false,
      style,
    });
  });

  it.each([
    ["a style it does not know", "console"],
    ["a name in the wrong case", "Shapes"],
    ["an empty name", ""],
    ["a number", 1],
    ["nothing", null],
    ["a list", ["shapes"]],
  ])("takes Kuutti's own marks for %s and keeps the rest", (_what, style) => {
    expect(readDecisionButtons(JSON.stringify({ oneHanded: true, style }))).toEqual({
      hand: "right",
      oneHanded: true,
      style: "kuutti",
    });
  });
});

describe("the provider", () => {
  it("reads the stored choice once and writes every change back as JSON", async () => {
    store.set(KEY, JSON.stringify({ hand: "left" }));
    const { result } = await renderHook(() => useDecisionButtons(), { wrapper });
    await waitFor(() => expect(result.current.settings.hand).toBe("left"));
    await act(async () => result.current.set({ oneHanded: true }));
    await act(async () => result.current.set({ style: "shapes" }));
    const kept = { hand: "left", oneHanded: true, style: "shapes" };
    expect(result.current.settings).toEqual(kept);
    await waitFor(() => expect(JSON.parse(store.get(KEY) ?? "{}")).toEqual(kept));
  });

  it("lets a stored choice that arrives after the provider has gone change nothing", async () => {
    let arrive: (value: string | null) => void = () => undefined;
    jest
      .spyOn(SecureStore, "getItemAsync")
      .mockReturnValueOnce(new Promise((resolve) => (arrive = resolve)));
    const { result, unmount } = await renderHook(() => useDecisionButtons(), { wrapper });
    expect(result.current.settings).toEqual(DEFAULT_DECISION_BUTTONS);
    await unmount();
    await act(async () => arrive(JSON.stringify({ hand: "left" })));
    expect(result.current.settings).toEqual(DEFAULT_DECISION_BUTTONS);
  });

  it("is needed above the hook", async () => {
    const silence = jest.spyOn(console, "error").mockImplementation(() => undefined);
    function Probe() {
      useDecisionButtons();
      return null;
    }
    await expect(render(<Probe />)).rejects.toThrow(
      "useDecisionButtons needs a DecisionButtonsProvider",
    );
    silence.mockRestore();
  });
});
