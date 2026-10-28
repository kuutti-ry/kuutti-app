import { screen } from "@testing-library/react-native";
import X from "lucide-react-native/icons/x";
import { Text, View } from "react-native";
import { Icon } from "@/components/ui/icon";
import { type HostNode, hiddenNodes, markBefore } from "./a11y";
import { renderWithTheme } from "./render";

// The checks the screens' tests use for a decorative mark (#474): the nodes a
// screen reader skips, and whether one stands just before a name. Each answer
// is asserted, so a check that said yes to any tree would fail here.

const tree = () => screen.toJSON() as HostNode | HostNode[] | null;

describe("hiddenNodes", () => {
  it("finds every node hidden from screen readers, at any depth, and nothing else", async () => {
    await renderWithTheme(
      <View>
        <Icon as={X} />
        <View>
          <Text>Words</Text>
          <Icon as={X} />
        </View>
      </View>,
    );
    expect(hiddenNodes(tree())).toHaveLength(2);
  });

  it("finds none in a tree without one, or in no tree", async () => {
    await renderWithTheme(<Text>Words</Text>);
    expect(hiddenNodes(tree())).toEqual([]);
    expect(hiddenNodes(null)).toEqual([]);
  });
});

describe("markBefore", () => {
  it("is true for a hidden node just before the words", async () => {
    await renderWithTheme(
      <View>
        <Icon as={X} />
        <Text>Instagram</Text>
      </View>,
    );
    expect(markBefore(tree(), "Instagram")).toBe(true);
  });

  it("is false for text just before the words, even with a hidden node earlier", async () => {
    await renderWithTheme(
      <View>
        <Icon as={X} />
        <Text>Telegram</Text>
        <Text>Instagram</Text>
      </View>,
    );
    expect(markBefore(tree(), "Instagram")).toBe(false);
  });

  it("is false for words with nothing before them", async () => {
    await renderWithTheme(
      <View>
        <Text>Instagram</Text>
        <Icon as={X} />
      </View>,
    );
    expect(markBefore(tree(), "Instagram")).toBe(false);
  });

  it("is null for words no text holds", async () => {
    await renderWithTheme(
      <View>
        <Icon as={X} />
        <Text>Instagram</Text>
      </View>,
    );
    expect(markBefore(tree(), "Snapchat")).toBeNull();
    expect(markBefore(null, "Instagram")).toBeNull();
  });
});
