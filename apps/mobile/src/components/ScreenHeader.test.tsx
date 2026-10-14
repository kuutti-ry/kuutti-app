import { fireEvent, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { ScreenHeader } from "./ScreenHeader";

// The top of a screen: the way back and the title, pinned above the content
// by the screen that draws it (src/test/layout.ts holds the screens to that).

describe("ScreenHeader", () => {
  it("names the screen as a header and the arrow by where it goes", async () => {
    const onBack = jest.fn();
    await renderWithTheme(
      <ScreenHeader title="The basics" backLabel="Back to your profile" onBack={onBack} />,
    );
    expect(screen.getByRole("heading", { name: "The basics" })).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Back to your profile" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
  });

  it("puts what it is given after the title", async () => {
    await renderWithTheme(
      <ScreenHeader title="Your profile" backLabel="Back" onBack={jest.fn()}>
        <Text>See your card</Text>
      </ScreenHeader>,
    );
    const texts = (screen.toJSON() as HostNode).children ?? [];
    expect(JSON.stringify(texts).indexOf("Your profile")).toBeLessThan(
      JSON.stringify(texts).indexOf("See your card"),
    );
  });
});
