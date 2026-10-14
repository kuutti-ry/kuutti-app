import { fireEvent, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { RowGroup } from "./RowGroup";

// The rows of a list (#227, #287): a row that opens a screen is a button named
// by its title, with the summary as the hint and the state as the value; a
// row with nothing to open is read with its detail.

describe("RowGroup", () => {
  it("makes a button of a row that opens, with its words where a screen reader expects them", async () => {
    const open = jest.fn();
    await renderWithTheme(
      <RowGroup
        rows={[
          {
            key: "a",
            title: "The basics",
            summary: "Name and height",
            value: "2 of 5 answered",
            mark: <Text>mark</Text>,
            onPress: open,
          },
          { key: "b", title: "Prompts", onPress: () => {} },
        ]}
      />,
    );
    const basics = screen.getByRole("button", { name: "The basics" });
    expect(basics.props.accessibilityHint).toBe("Name and height");
    expect(basics.props.accessibilityValue).toEqual({ text: "2 of 5 answered" });
    expect(screen.getByText("mark")).toBeTruthy();
    const prompts = screen.getByRole("button", { name: "Prompts" });
    expect(prompts.props.accessibilityHint).toBeUndefined();
    expect(prompts.props.accessibilityValue?.text).toBeUndefined();
    await fireEvent.press(basics);
    expect(open).toHaveBeenCalledTimes(1);
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
  });

  it("reads a row with nothing to open, its detail as the value", async () => {
    await renderWithTheme(
      <RowGroup
        rows={[{ key: "v", title: "Version", summary: "Build abc1234", detail: "0.19.0" }]}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    const version = screen.getByLabelText("Version");
    expect(version.props.accessibilityValue).toEqual({ text: "0.19.0" });
    expect(screen.getByText("0.19.0")).toBeTruthy();
    expect(screen.getByText("Build abc1234")).toBeTruthy();
  });
});
