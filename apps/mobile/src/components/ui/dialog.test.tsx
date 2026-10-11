import { fireEvent, render, screen } from "@testing-library/react-native";
import { Platform, StyleSheet, Text } from "react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogTitle,
} from "./dialog";

// The dialog (#12, TD-9): a labelled 44 pt close control, a scrim that is not
// an accessibility element, and on the web preview a tap on the scrim itself,
// not on the dialog, closes it.

describe("Dialog", () => {
  it("shows its title and body with a labelled close control that closes it", async () => {
    const onOpenChange = jest.fn();
    await renderWithTheme(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent closeLabel="Close the question">
          <DialogHeader>
            <DialogTitle>Remove this photo?</DialogTitle>
            <DialogDescription>It is deleted for good.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Text>Footer</Text>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByText("Remove this photo?")).toBeTruthy();
    expect(screen.getByText("It is deleted for good.")).toBeTruthy();
    expect(screen.getByText("Footer")).toBeTruthy();
    const close = screen.getByRole("button", { name: "Close the question" });
    expect(StyleSheet.flatten(close.props.style)).toMatchObject({ minHeight: 44, minWidth: 44 });
    expect(pressables(screen.toJSON() as HostNode).flatMap((n) => a11yProblems(n))).toEqual([]);
    await fireEvent.press(close);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows nothing while closed", async () => {
    await renderWithTheme(
      <Dialog open={false}>
        <DialogContent closeLabel="Close">
          <DialogTitle>Hidden</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByText("Hidden")).toBeNull();
  });

  it("hands a press on the scrim to the caller on the phone", async () => {
    const onPress = jest.fn();
    const onOpenChange = jest.fn();
    await render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogOverlay testID="scrim" onPress={onPress}>
          <Text>Inside</Text>
        </DialogOverlay>
      </Dialog>,
    );
    const scrim = screen.getByTestId("scrim");
    expect(scrim.props.accessible).toBe(false);
    await fireEvent.press(scrim);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("Dialog on the web preview", () => {
  // Platform.select picks the web branch at render time; jest-expo's preset is iOS.
  // Jest resolves the primitive's native overlay, which closes on any press by
  // itself; the web one (Radix) does not, so its own close is switched off here
  // and the decision is left to the handler under test, as on the web.
  beforeEach(() => {
    jest.replaceProperty(Platform, "OS", "web");
    // The module picked iOS's FullWindowOverlay when it loaded; off iOS it warns, which is beside the point here.
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest
      .spyOn(Platform, "select")
      .mockImplementation(((spec: Record<string, unknown>) =>
        "web" in spec ? spec.web : spec.default) as typeof Platform.select);
  });
  afterEach(() => jest.restoreAllMocks());

  async function showOverlay(onPress?: jest.Mock) {
    const onOpenChange = jest.fn();
    await render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogOverlay testID="scrim" closeOnPress={false} onPress={onPress}>
          <Text>Inside</Text>
        </DialogOverlay>
      </Dialog>,
    );
    return { onOpenChange, scrim: screen.getByTestId("scrim") };
  }
  const pressEvent = (target: unknown, currentTarget: unknown, prevented = false) => ({
    target,
    currentTarget,
    isDefaultPrevented: () => prevented,
  });

  it("closes for a tap on the scrim itself, and tells the caller first", async () => {
    const onPress = jest.fn();
    const { onOpenChange, scrim } = await showOverlay(onPress);
    await fireEvent.press(scrim, pressEvent(1, 1));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stays open for a tap that landed inside the dialog", async () => {
    const { onOpenChange, scrim } = await showOverlay();
    await fireEvent.press(scrim, pressEvent(2, 1));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("stays open when the caller prevented the default", async () => {
    const onPress = jest.fn();
    const { onOpenChange, scrim } = await showOverlay(onPress);
    await fireEvent.press(scrim, pressEvent(1, 1, true));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
