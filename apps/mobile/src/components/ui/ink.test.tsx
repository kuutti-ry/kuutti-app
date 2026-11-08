import { screen } from "@testing-library/react-native";
import { type HostNode, hiddenNodes } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { Ink } from "./ink";

// Ink (#474): a drawing in ink, tinted with a text colour class, decorative:
// hidden from VoiceOver and TalkBack alike, nothing a screen reader meets.

describe("Ink", () => {
  it("is hidden from both screen readers", async () => {
    await renderWithTheme(
      <Ink source={require("../../../assets/logo-mark.png")} className="h-5 w-5 text-foreground" />,
    );
    const [node] = hiddenNodes(screen.toJSON() as HostNode);
    expect(node?.props).toMatchObject({
      accessibilityElementsHidden: true,
      importantForAccessibility: "no",
    });
    expect(screen.queryByRole("image")).toBeNull();
  });
});
