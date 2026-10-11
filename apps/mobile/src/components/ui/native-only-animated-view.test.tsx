import { fireEvent, render, screen } from "@testing-library/react-native";
import { Platform, Text } from "react-native";
import { NativeOnlyAnimatedView } from "./native-only-animated-view";

// Animations on the phone only (#12): on the web preview the wrapper is
// nothing but its children.

afterEach(() => jest.restoreAllMocks());

describe("NativeOnlyAnimatedView", () => {
  it("is an animated view around its children on the phone", async () => {
    await render(
      <NativeOnlyAnimatedView testID="wrapper">
        <Text>Inside</Text>
      </NativeOnlyAnimatedView>,
    );
    const wrapper = screen.getByTestId("wrapper");
    expect(wrapper.props.jestAnimatedStyle).toBeDefined();
    expect(screen.getByText("Inside")).toBeTruthy();
  });

  it("is an animated pressable when asked for one, and passes presses on", async () => {
    const pressed = jest.fn();
    await render(
      <NativeOnlyAnimatedView as="Pressable" testID="wrapper" onPress={pressed}>
        <Text>Tap</Text>
      </NativeOnlyAnimatedView>,
    );
    await fireEvent.press(screen.getByTestId("wrapper"));
    expect(pressed).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("wrapper").props.jestAnimatedStyle).toBeDefined();
  });

  it("is only its children on the web preview", async () => {
    jest.replaceProperty(Platform, "OS", "web");
    await render(
      <NativeOnlyAnimatedView testID="wrapper">
        <Text>Inside</Text>
      </NativeOnlyAnimatedView>,
    );
    expect(screen.queryByTestId("wrapper")).toBeNull();
    expect(screen.getByText("Inside")).toBeTruthy();
  });
});
