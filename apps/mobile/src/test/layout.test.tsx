import { screen } from "@testing-library/react-native";
import { ScrollView, Text, View } from "react-native";
import { ScreenHeader } from "@/components/ScreenHeader";
import type { HostNode } from "./a11y";
import { expectPinnedHeader, hasCutText } from "./layout";
import { renderWithTheme } from "./render";

// The check the screens' tests use for a pinned header: it passes for a header
// above the scroll and fails for one that scrolls away with the content.

const header = <ScreenHeader title="Settings" backLabel="Back" onBack={() => {}} />;

describe("hasCutText", () => {
  const cut = async (ui: React.ReactElement) => {
    await renderWithTheme(ui);
    return hasCutText(screen.toJSON() as HostNode);
  };

  it.each([
    ["a line count", <Text numberOfLines={2}>Long</Text>, true],
    ["a fixed height", <Text style={{ height: 20 }}>Long</Text>, true],
    ["a minimum height", <Text style={{ minHeight: 20 }}>Long</Text>, false],
    [
      "a line count it shrinks to",
      <Text numberOfLines={1} adjustsFontSizeToFit>
        Long
      </Text>,
      false,
    ],
    ["neither", <Text>Long</Text>, false],
    ["a height on what is not text", <View style={{ height: 20 }} />, false],
  ])("reads %s", async (_what, ui, expected) => {
    expect(await cut(ui)).toBe(expected);
  });

  it("reads a tree that is several roots, and none", () => {
    const text = (props: Record<string, unknown>): HostNode => ({
      type: "Text",
      props,
      children: null,
    });
    expect(hasCutText([text({}), text({ numberOfLines: 1 })])).toBe(true);
    expect(hasCutText(null)).toBe(false);
  });
});

describe("expectPinnedHeader", () => {
  it("passes for a title and an arrow above the scroll", async () => {
    await renderWithTheme(
      <View>
        {header}
        <ScrollView>
          <Text>Theme</Text>
        </ScrollView>
      </View>,
    );
    expectPinnedHeader("Settings", "Back");
  });

  it("fails for a title and an arrow inside the scroll", async () => {
    await renderWithTheme(
      <ScrollView>
        {header}
        <Text>Theme</Text>
      </ScrollView>,
    );
    expect(() => expectPinnedHeader("Settings", "Back")).toThrow(/not\.toContain/);
  });
});
