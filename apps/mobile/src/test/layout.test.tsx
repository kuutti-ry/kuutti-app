import { ScrollView, Text, View } from "react-native";
import { ScreenHeader } from "@/components/ScreenHeader";
import { expectPinnedHeader } from "./layout";
import { renderWithTheme } from "./render";

// The check the screens' tests use for a pinned header: it passes for a header
// above the scroll and fails for one that scrolls away with the content.

const header = <ScreenHeader title="Settings" backLabel="Back" onBack={() => {}} />;

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
