import { AccessibilityInfo, type View } from "react-native";
import { focusOnMount } from "./a11y";

// The screen reader's focus moved to what has just appeared (#581): a dialog's
// title, or the line in a removed button's place.

describe("focusOnMount", () => {
  // The module mock keeps its calls across tests: each test starts from none.
  const sent = () => jest.spyOn(AccessibilityInfo, "sendAccessibilityEvent").mockClear();
  afterEach(() => jest.restoreAllMocks());

  it("moves the reader's focus to the element as it mounts", () => {
    const spy = sent();
    const node = {} as View;
    focusOnMount(node);
    expect(spy.mock.calls).toEqual([[node, "focus"]]);
  });

  it("does nothing as the element goes", () => {
    const spy = sent();
    focusOnMount(null);
    expect(spy).not.toHaveBeenCalled();
  });
});
