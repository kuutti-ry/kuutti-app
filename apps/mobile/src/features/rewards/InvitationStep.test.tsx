import { act, fireEvent, screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { InvitationStep } from "./InvitationStep";

// Onboarding's optional step after the welcome (#107): what a code earns the
// person while it earns them anything (#503), the field and Skip; after a code
// that worked, that it is in, and Continue; either way the step is done, in the
// phone's language.

const ONE_EACH = { inviterFish: 1, friendFish: 1 };
const EARNS = "The code earns you a fish and your friend a fish once your profile is complete.";
const EXPLAIN =
  "If a friend gave you an invitation code, type it here. You can also skip this and type it later in Settings, until your profile is complete.";
/** Every text on the screen, in order. */
const drawn = () => screen.queryAllByText(/./).map((node) => node.props.children);
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
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("InvitationStep", () => {
  it("offers the field and Skip, and Skip is done with the step", async () => {
    const onDone = jest.fn();
    await renderWithTheme(<InvitationStep reward={ONE_EACH} onDone={onDone} />);
    expect(screen.getByRole("heading", { name: "Did a friend invite you?" })).toBeTruthy();
    expect(screen.getByText(EXPLAIN)).toBeTruthy();
    expect(screen.getByLabelText("Invitation code")).toBeTruthy();
    noProblems();
    await press("Skip");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("says what a code earns between the explanation and the field", async () => {
    await renderWithTheme(<InvitationStep reward={ONE_EACH} onDone={jest.fn()} />);
    const flat = JSON.stringify(screen.toJSON());
    expect(flat.indexOf("If a friend gave you")).toBeGreaterThan(-1);
    expect(flat.indexOf("If a friend gave you")).toBeLessThan(flat.indexOf(EARNS));
    expect(flat.indexOf(EARNS)).toBeLessThan(flat.indexOf("Use the code"));
  });

  it.each([
    ["en", { inviterFish: 1, friendFish: 1 }, EARNS],
    [
      "en",
      { inviterFish: 3, friendFish: 2 },
      "The code earns you 2 fish and your friend 3 fish once your profile is complete.",
    ],
    [
      "en",
      { inviterFish: 0, friendFish: 1 },
      "The code earns you a fish once your profile is complete.",
    ],
    [
      "en",
      { inviterFish: 0, friendFish: 2 },
      "The code earns you 2 fish once your profile is complete.",
    ],
    [
      "fi",
      { inviterFish: 1, friendFish: 1 },
      "Koodista saat kalan ja ystäväsi saa kalan, kun profiilisi on valmis.",
    ],
    ["fi", { inviterFish: 0, friendFish: 2 }, "Koodista saat 2 kalaa, kun profiilisi on valmis."],
    [
      "sv",
      { inviterFish: 1, friendFish: 1 },
      "Koden ger dig en fisk och din vän en fisk när din profil är klar.",
    ],
    ["sv", { inviterFish: 0, friendFish: 2 }, "Koden ger dig 2 fiskar när din profil är klar."],
  ])("says in %s what the reward %j earns the person", async (locale, reward, words) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: locale }]);
    await renderWithTheme(<InvitationStep reward={reward} onDone={jest.fn()} />);
    expect(await screen.findByText(words)).toBeTruthy();
    noProblems();
  });

  it.each([[{ inviterFish: 1, friendFish: 0 }], [{ inviterFish: 0, friendFish: 0 }]])(
    "leaves the line out where the person earns nothing, %j",
    async (reward) => {
      await renderWithTheme(<InvitationStep reward={reward} onDone={jest.fn()} />);
      expect(screen.getByLabelText("Invitation code")).toBeTruthy();
      expect(drawn()).toEqual([
        "Did a friend invite you?",
        EXPLAIN,
        "Invitation code",
        "Use the code",
        "Skip",
      ]);
      noProblems();
    },
  );

  it("says that a code that worked is in, and Continue is done with the step", async () => {
    const onDone = jest.fn();
    await renderWithTheme(<InvitationStep reward={ONE_EACH} onDone={onDone} />);
    await act(async () =>
      fireEvent.changeText(screen.getByLabelText("Invitation code"), "abcdefghjk"),
    );
    await press("Use the code");
    expect(screen.getByText("The code is in.").props.accessibilityLiveRegion).toBe("polite");
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.queryByLabelText("Invitation code")).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
    noProblems();
    await press("Continue");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("speaks the phone's language", async () => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: "fi-FI" }]);
    await renderWithTheme(<InvitationStep reward={ONE_EACH} onDone={jest.fn()} />);
    expect(await screen.findByRole("heading", { name: "Kutsuiko ystävä sinut?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ohita" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Käytä koodi" })).toBeTruthy();
  });
});
