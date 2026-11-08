import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { AccessibilityInfo, Linking } from "react-native";
import { ApiError } from "@/lib/api";
import { updateApp } from "@/lib/app-update";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { LoadFailed } from "./LoadFailed";

// What a screen shows when something did not load (outside production): why in
// words, heard at once, and the way out that fits the failure (#581).

jest.mock("@/lib/app-update", () => ({ updateApp: jest.fn() }));
const update = updateApp as jest.Mock;

const outdated = Object.assign(new Error("contract"), { name: "ZodError" });
const heard = AccessibilityInfo.announceForAccessibilityWithOptions as jest.Mock;

async function show(error: unknown, onRetry = jest.fn()) {
  await renderWithTheme(<LoadFailed error={error} onRetry={onRetry} />);
  return onRetry;
}

beforeEach(() => {
  update.mockReset();
  heard.mockClear();
});

describe("LoadFailed", () => {
  it.each([
    [
      "no answer",
      new TypeError("Network request failed"),
      "Kuutti could not be reached. Check your connection.",
    ],
    [
      "a server error",
      new ApiError("profile answered 500", 500),
      "Kuutti's server had a problem. Try again in a moment.",
    ],
    ["anything else", new Error("boom"), "Something unexpected went wrong."],
  ])("says why after %s, and tries again on request", async (_, error, why) => {
    const onRetry = await show(error);
    // The reason takes over what a screen reader hears at once: a live region, and aloud on iOS.
    expect(screen.getByText(why).props.accessibilityLiveRegion).toBe("assertive");
    expect(screen.getByText(why).props.className).toMatch(/\btext-center\b/);
    expect(heard).toHaveBeenCalledWith(why, { queue: true });
    expect(screen.queryByRole("button", { name: "Update the app" })).toBeNull();
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  });

  it("offers to update an app older than its API, and no retry that cannot help", async () => {
    update.mockReturnValue(new Promise(() => undefined));
    const onRetry = await show(outdated);
    expect(screen.getByText("This version of the app is older than Kuutti's server.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Update the app" }));
    });
    // While the update downloads, the button says so and cannot be pressed twice.
    await waitFor(() => expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled());
    expect(update).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("waits, saying it updates, while the app restarts into the update", async () => {
    update.mockResolvedValue("restarting");
    await show(outdated);
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Update the app" }));
    });
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
    expect(screen.queryByText(/No update is available/)).toBeNull();
  });

  it("says to install the newest version when this build has no update, and opens the install page", async () => {
    update.mockResolvedValue("none");
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await show(outdated);
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Update the app" }));
    });
    expect(
      await screen.findByText(
        "No update is available for this app yet. Install the newest version of Kuutti.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update the app" })).toBeNull();
    fireEvent.press(screen.getByRole("button", { name: "Open the install page" }));
    expect(open).toHaveBeenCalledWith("https://expo.dev/accounts/kuutti/projects/kuutti/builds");
    open.mockRestore();
  });
});
