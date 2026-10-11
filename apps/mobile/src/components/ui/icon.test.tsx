import { screen } from "@testing-library/react-native";
import X from "lucide-react-native/icons/x";
import { renderWithTheme } from "@/test/render";
import { Icon } from "./icon";

// Icons are decorative (#12): hidden from screen readers, because the control
// around them carries the label; 20 pt unless asked otherwise.

const icon = () => screen.getByTestId("icon", { includeHiddenElements: true });

describe("Icon", () => {
  it("is hidden from screen readers, at 20 pt by default", async () => {
    await renderWithTheme(<Icon as={X} testID="icon" />);
    expect(icon().props.accessibilityElementsHidden).toBe(true);
    expect(icon().props.importantForAccessibility).toBe("no");
    expect(screen.queryByTestId("icon")).toBeNull();
    expect([icon().props.width, icon().props.height]).toEqual([20, 20]);
  });

  it("draws at the size it is given", async () => {
    await renderWithTheme(<Icon as={X} testID="icon" size={32} />);
    expect([icon().props.width, icon().props.height]).toEqual([32, 32]);
  });
});
