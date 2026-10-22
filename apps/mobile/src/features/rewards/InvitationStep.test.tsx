import { act, fireEvent, screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { InvitationStep } from "./InvitationStep";

// Onboarding's optional step after the welcome (#107): the field and Skip;
// after a code that worked, the thanks and Continue; either way the step is
// done, in the phone's language.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);
const press = async (name: string) => {
  await act(async () => fireEvent.press(screen.getByRole("button", { name })));
  await settle();
};

beforeEach(async () => {
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  globalThis.fetch = jest.fn(
    async () => new Response(null, { status: 204 }),
  ) as unknown as typeof fetch;
  await clearSession();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("InvitationStep", () => {
  it("offers the field and Skip, and Skip is done with the step", async () => {
    const onDone = jest.fn();
    await renderWithTheme(<InvitationStep onDone={onDone} />);
    expect(screen.getByRole("heading", { name: "Did a friend invite you?" })).toBeTruthy();
    expect(
      screen.getByText(
        "If a friend gave you an invitation code, type it here. You can also skip this and type it later in Settings, until your profile is complete.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Invitation code")).toBeTruthy();
    noProblems();
    await press("Skip");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("thanks the person for a code that worked, and Continue is done with the step", async () => {
    const onDone = jest.fn();
    await renderWithTheme(<InvitationStep onDone={onDone} />);
    await act(async () =>
      fireEvent.changeText(screen.getByLabelText("Invitation code"), "abcdefghjk"),
    );
    await press("Use the code");
    expect(
      screen.getByText(
        "The code is in. Your friend's invitation counts once your profile is complete.",
      ).props.accessibilityLiveRegion,
    ).toBe("polite");
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.queryByLabelText("Invitation code")).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
    noProblems();
    await press("Continue");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("speaks the phone's language", async () => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: "fi-FI" }]);
    await renderWithTheme(<InvitationStep onDone={jest.fn()} />);
    expect(await screen.findByRole("heading", { name: "Kutsuiko ystävä sinut?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ohita" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Käytä koodi" })).toBeTruthy();
  });
});
