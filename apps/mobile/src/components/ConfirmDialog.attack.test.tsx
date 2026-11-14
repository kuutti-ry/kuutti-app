import { fireEvent, screen } from "@testing-library/react-native";
import { attack } from "@/test/attack";
import { renderWithTheme } from "@/test/render";
import { ConfirmDialog } from "./ConfirmDialog";

async function pressed(name: string) {
  const changed = jest.fn();
  const cancelled = jest.fn();
  await renderWithTheme(
    <ConfirmDialog
      open
      closeLabel="Close the question"
      title="Remove this photo?"
      body="It is deleted for good."
      cancel="Keep it"
      confirm="Remove"
      onCancel={cancelled}
      onConfirm={changed}
    />,
  );
  await fireEvent.press(screen.getByRole("button", { name }));
  if (name !== "Remove") expect(cancelled).toHaveBeenCalledTimes(1);
  return changed.mock.calls.length;
}

for (const name of ["Keep it", "Close the question"]) {
  attack(
    `mobile confirmation: ${name} performs the destructive action instead of leaving it alone`,
    {
      attempt: () => pressed(name),
      control: () => pressed("Remove"),
      succeeds: (changes) => expect(changes).toBeGreaterThan(0),
    },
  );
}
