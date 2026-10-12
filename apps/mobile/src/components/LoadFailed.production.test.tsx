import { act, fireEvent, screen } from "@testing-library/react-native";
import { updateApp } from "@/lib/app-update";
import { renderWithTheme } from "@/test/render";
import { LoadFailed } from "./LoadFailed";

// A production build: no link to the team's install page, only the words.

jest.mock("expo-updates", () => ({ channel: "production" }));
jest.mock("@/lib/app-update", () => ({ updateApp: jest.fn() }));

describe("LoadFailed in production", () => {
  it("says to install the newest version, and links nowhere", async () => {
    (updateApp as jest.Mock).mockResolvedValue("none");
    await renderWithTheme(
      <LoadFailed
        headline="Your profile could not be loaded."
        error={Object.assign(new Error("contract"), { name: "ZodError" })}
        onRetry={jest.fn()}
      />,
    );
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Update the app" }));
    });
    expect(
      await screen.findByText(
        "No update is available for this app yet. Install the newest version of Kuutti.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open the install page" })).toBeNull();
  });
});
