import { fireEvent, screen } from "@testing-library/react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { ConfirmDialog } from "./ConfirmDialog";

// The question before a change that cannot be taken back (#610): what it does,
// a way out, and the change in the destructive colour.

async function ask(body?: string) {
  const onCancel = jest.fn();
  const onConfirm = jest.fn();
  await renderWithTheme(
    <ConfirmDialog
      open
      closeLabel="Close the question"
      title="Remove this photo?"
      body={body}
      cancel="Keep it"
      confirm="Remove"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  return { onCancel, onConfirm };
}

describe("ConfirmDialog", () => {
  it("asks its question with what it does, and labels every control", async () => {
    await ask("It is deleted for good.");
    expect(screen.getByText("Remove this photo?")).toBeTruthy();
    expect(screen.getByText("It is deleted for good.")).toBeTruthy();
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
  });

  it("draws no description when it is given none", async () => {
    await ask();
    expect(screen.getByText("Remove this photo?")).toBeTruthy();
    expect(screen.queryByText("It is deleted for good.")).toBeNull();
  });

  it("makes the change only on its own button, in the destructive colour", async () => {
    const { onCancel, onConfirm } = await ask("It is deleted for good.");
    const confirm = screen.getByRole("button", { name: "Remove" });
    expect(confirm.props.className).toContain("bg-destructive");
    fireEvent.press(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it.each([
    ["its way out", "Keep it"],
    ["its close control", "Close the question"],
  ])("changes nothing when it is closed by %s", async (_, name) => {
    const { onCancel, onConfirm } = await ask("It is deleted for good.");
    fireEvent.press(screen.getByRole("button", { name }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
