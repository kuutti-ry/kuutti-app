import { screen } from "@testing-library/react-native";
import { Icon } from "@/components/ui/icon";
import { type HostNode, hiddenNodes } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { DECISION_ICONS } from "./faceButtons";

// The marks Like and Pass can carry (#520): one ink, the text's, so that no
// console's colours come in and the four token sets hold; decorative, so the
// word stays the meaning.

const paths = (node: HostNode | string): HostNode[] => {
  if (typeof node === "string") return [];
  return [...(node.type === "RNSVGPath" ? [node] : []), ...(node.children ?? []).flatMap(paths)];
};

describe("the face buttons (#520)", () => {
  it.each([
    ["✕", DECISION_ICONS.shapes.like],
    ["○", DECISION_ICONS.shapes.pass],
    ["A", DECISION_ICONS.letters.like],
    ["B", DECISION_ICONS.letters.pass],
  ])("draws %s as a disc in the text's colour with the mark cut out of it", async (_mark, icon) => {
    await renderWithTheme(<Icon as={icon} />);
    const tree = screen.toJSON() as HostNode;
    const drawn = paths(tree);
    expect(drawn).toHaveLength(1);
    const [{ props }] = drawn as [HostNode];
    // The disc first, and more after it: a mark, not a filled circle.
    expect(props.d).toMatch(/^M23 12a11 11 0 1 1-22 0a11 11 0 1 1 22 0Z.+/);
    expect(props.fillRule).toBe(0); // even-odd
    expect(props.fill).toEqual({ type: 2 }); // currentColor
    expect(props.stroke).toBeNull();
    expect(hiddenNodes(tree)).toHaveLength(1);
  });
});
