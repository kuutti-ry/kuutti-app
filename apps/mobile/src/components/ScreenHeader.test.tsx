import { fireEvent, render, screen } from "@testing-library/react-native";
import { Platform, Text } from "react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { HEADING_FONT_SCALE } from "@/theme/a11y";
import { ScreenHeader } from "./ScreenHeader";

// The top of a screen: the way back and the title, pinned above the content
// by the screen that draws it (src/test/layout.ts holds the screens to that).

afterEach(() => jest.restoreAllMocks());

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

  it("keeps the title on one line that shrinks to fit, so no word breaks in the middle (#467)", async () => {
    await renderWithTheme(
      <ScreenHeader title="Valintapainikkeet" backLabel="Takaisin" onBack={jest.fn()} />,
    );
    const title = screen.getByRole("heading", { name: "Valintapainikkeet" });
    expect(title.props.numberOfLines).toBe(1);
    expect(title.props.adjustsFontSizeToFit).toBe(true);
    // It grows with the OS as h1 does, and shrinks from there only as needed.
    expect(title.props.maxFontSizeMultiplier).toBe(HEADING_FONT_SCALE.h1);
    // h1's size with no fixed line height, which would keep a shrunk title
    // low on iOS: the variant's own text-h1 and its 36 pt line are gone.
    expect(title.props.className).toMatch(/(^| )text-h1\/\[normal\]( |$)/);
    expect(title.props.className).not.toMatch(/(^| )text-h1( |$)/);
  });

  it("lets the title wrap in the web preview, which cannot shrink it and would cut it at one line", async () => {
    jest.replaceProperty(Platform, "OS", "web");
    // Without the theme, whose own web branch needs NativeWind's web build.
    await render(
      <ScreenHeader title="Valintapainikkeet" backLabel="Takaisin" onBack={jest.fn()} />,
    );
    const title = screen.getByRole("heading", { name: "Valintapainikkeet" });
    expect(title.props.numberOfLines).toBeUndefined();
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

describe("ScreenHeader's way back", () => {
  const { __router: router } = jest.requireMock("expo-router") as { __router: { back: jest.Mock } };
  beforeEach(() => router.back.mockClear());

  it("goes one step back when the screen gives no other way", async () => {
    await renderWithTheme(<ScreenHeader title="Photos" backLabel="Back to your profile" />);
    fireEvent.press(screen.getByRole("button", { name: "Back to your profile" }));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("goes the screen's own way, and not back, when it is given one", async () => {
    const onBack = jest.fn();
    await renderWithTheme(
      <ScreenHeader title="Photos" backLabel="Back to your profile" onBack={onBack} />,
    );
    fireEvent.press(screen.getByRole("button", { name: "Back to your profile" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(router.back).not.toHaveBeenCalled();
  });
});
