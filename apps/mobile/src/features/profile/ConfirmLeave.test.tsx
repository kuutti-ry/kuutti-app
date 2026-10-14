import { act, cleanup, fireEvent, screen } from "@testing-library/react-native";
import { useState } from "react";
import { Pressable, Text } from "react-native";
import { renderWithTheme } from "@/test/render";
import { ConfirmLeaveDialog, holdLinkWhileUnsaved, useConfirmLeave } from "./ConfirmLeave";

// The hold on leaving with something unsaved (#285): the stack's beforeRemove
// and a link from outside the app wait for the person's word in one dialog.

const { __navigation: navigation, __navigationListeners: listeners } = jest.requireMock(
  "expo-router",
) as {
  __navigation: {
    dispatch: jest.Mock;
    setOptions: jest.Mock;
    emit: (name: string, event: unknown) => void;
  };
  __navigationListeners: Map<string, Set<unknown>>;
};

/**
 * A screen that may hold something unsaved, saying whether it is asking: on
 * the word it drops its change, as the screens reset their draft, and a press
 * on "Change <name>" makes a new one.
 */
function Holder({ name, unsaved: changed }: { name: string; unsaved: boolean }) {
  const [unsaved, setUnsaved] = useState(changed);
  const leaving = useConfirmLeave(unsaved, () => setUnsaved(false));
  return (
    <>
      <Text>{leaving.asking ? `${name} asks` : `${name} is quiet`}</Text>
      <Text>{unsaved ? `${name} holds a change` : `${name} holds nothing`}</Text>
      <Pressable accessibilityRole="button" onPress={() => setUnsaved(true)}>
        <Text>Change {name}</Text>
      </Pressable>
      <ConfirmLeaveDialog {...leaving} />
    </>
  );
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const press = (name: string) =>
  act(async () => {
    fireEvent.press(screen.getByRole("button", { name }));
    await settle();
  });
/** The arrow, Android's back key or a pop of several screens, as the stack reports it. */
const back = async () => {
  const event = { preventDefault: jest.fn(), data: { action: { type: "GO_BACK" } } };
  await act(async () => {
    navigation.emit("beforeRemove", event);
    await settle();
  });
  return event;
};
/**
 * A link from outside the app, as Expo Router hands it to +native-intent. The
 * outcome comes back in a box: a held link is a promise that only the word
 * resolves, so it must not be awaited here.
 */
const link = async (path: string, initial = false) => {
  const box: { outcome: string | Promise<string | null> } = { outcome: path };
  await act(async () => {
    box.outcome = holdLinkWhileUnsaved(path, initial);
    await settle();
  });
  return box;
};

beforeEach(() => {
  navigation.dispatch.mockClear();
});
// Each test's screens are taken down: a holder left mounted would keep listening.
afterEach(() => {
  cleanup();
  // A screen taken down stops listening; a leftover would hold the next test's leave.
  expect(listeners.get("beforeRemove")?.size ?? 0).toBe(0);
});

describe("useConfirmLeave", () => {
  it("lets a link through when nothing is unsaved", async () => {
    await renderWithTheme(<Holder name="A" unsaved={false} />);
    expect((await link("kuutti://settings")).outcome).toBe("kuutti://settings");
    expect(screen.getByText("A is quiet")).toBeTruthy();
  });

  it("lets the first link of a cold start through, whatever is held", async () => {
    await renderWithTheme(<Holder name="A" unsaved />);
    expect((await link("kuutti://settings", true)).outcome).toBe("kuutti://settings");
    expect(screen.getByText("A is quiet")).toBeTruthy();
  });

  it("holds a link while something is unsaved, and follows it on the word", async () => {
    await renderWithTheme(<Holder name="A" unsaved />);
    const held = (await link("kuutti://")).outcome;
    expect(held).toBeInstanceOf(Promise);
    expect(screen.getByText("A asks")).toBeTruthy();
    expect(screen.getByText("Leave without saving?")).toBeTruthy();
    expect(screen.getByText("Your changes are not saved yet.")).toBeTruthy();
    await press("Leave without saving");
    await expect(held).resolves.toBe("kuutti://");
    expect(screen.getByText("A is quiet")).toBeTruthy();
    expect(navigation.dispatch).not.toHaveBeenCalled();
    // The change is dropped, so the screen, which a link leaves mounted under
    // the one it opens, holds nothing: the next link goes straight through.
    expect(screen.getByText("A holds nothing")).toBeTruthy();
    expect((await link("kuutti://settings")).outcome).toBe("kuutti://settings");
  });

  it("drops a held link on Keep editing, and keeps the change", async () => {
    await renderWithTheme(<Holder name="A" unsaved />);
    const held = (await link("kuutti://")).outcome;
    await press("Keep editing");
    await expect(held).resolves.toBeNull();
    expect(screen.getByText("A is quiet")).toBeTruthy();
    expect(screen.getByText("A holds a change")).toBeTruthy();
  });

  it("keeps the change and drops a held link when the dialog is closed", async () => {
    await renderWithTheme(<Holder name="A" unsaved />);
    const held = (await link("kuutti://")).outcome;
    await press("Close");
    await expect(held).resolves.toBeNull();
    expect(screen.getByText("A is quiet")).toBeTruthy();
    expect(screen.getByText("A holds a change")).toBeTruthy();
  });

  it("asks on the screen in front when both hold something", async () => {
    await renderWithTheme(
      <>
        <Holder name="under" unsaved />
        <Holder name="front" unsaved />
      </>,
    );
    const held = (await link("kuutti://")).outcome;
    expect(screen.getByText("front asks")).toBeTruthy();
    expect(screen.getByText("under is quiet")).toBeTruthy();
    await press("Keep editing");
    await expect(held).resolves.toBeNull();
  });

  it("asks on the screen under the front one when only that holds something", async () => {
    await renderWithTheme(
      <>
        <Holder name="under" unsaved />
        <Holder name="front" unsaved={false} />
      </>,
    );
    const held = (await link("kuutti://")).outcome;
    expect(screen.getByText("under asks")).toBeTruthy();
    expect(screen.getByText("front is quiet")).toBeTruthy();
    await press("Keep editing");
    await expect(held).resolves.toBeNull();
  });

  it("holds nothing after a leave without saving, and holds again after a new change", async () => {
    await renderWithTheme(<Holder name="A" unsaved />);
    const first = await back();
    expect(first.preventDefault).toHaveBeenCalled();
    await press("Leave without saving");
    expect(navigation.dispatch).toHaveBeenCalledWith({ type: "GO_BACK" });
    // The stack did nothing with it and the screen is still here: with its
    // change dropped, a leave passes; a new change is held again.
    expect(screen.getByText("A holds nothing")).toBeTruthy();
    expect((await back()).preventDefault).not.toHaveBeenCalled();
    await press("Change A");
    expect((await back()).preventDefault).toHaveBeenCalled();
    expect(screen.getByText("A asks")).toBeTruthy();
  });

  it("lets a leave through once the screen holds nothing", async () => {
    await renderWithTheme(<Holder name="A" unsaved={false} />);
    expect((await back()).preventDefault).not.toHaveBeenCalled();
    expect(navigation.setOptions).toHaveBeenLastCalledWith({ gestureEnabled: true });
  });
});
