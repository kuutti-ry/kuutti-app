import type { GateResponse, PondSummary, WaitlistResponse } from "@kuutti/schema";
import { fireEvent, screen, userEvent } from "@testing-library/react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { HomeRoute } from "./HomeRoute";
import { HomeScreen } from "./HomeScreen";

// The onboarding gate (#46) is the identity slice's; here it says what the
// test needs, so the screen can be seen complete, checking or unknown.
let mockGate:
  | { status: "checking" }
  | { status: "unknown" }
  | { status: "complete"; pond: PondSummary | null };
jest.mock("@/features/identity", () => ({
  ...jest.requireActual("@/features/identity"),
  useOnboardingGate: () => ({ ...mockGate, retry: mockRetry }),
}));
const mockRetry = jest.fn();

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock };
};

const POND: PondSummary = {
  id: "0b4f3a0e-7c2f-4e2b-9a9a-1a2b3c4d5e6f",
  slug: "otaniemi",
  name: "Otaniemi",
  nameInessive: "Otaniemessä",
  parentId: null,
};
const waitlist: WaitlistResponse = {
  k: 10,
  ponds: [{ pond: POND, day: "2026-10-05", verified: 150, split: null, finishing: null }],
};
const gate: GateResponse = { state: "closed", within: null, needed: 20, step: 10 };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const tokens = {
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token("access"),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: token("refresh"),
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
};

beforeEach(async () => {
  router.push.mockReset();
  mockRetry.mockReset();
  mockGate = { status: "complete", pond: POND };
  globalThis.fetch = jest.fn(async (input: Request | string) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/waitlist") return json(waitlist);
    if (url.pathname === "/gate") return json(gate);
    return json({ error: { code: "not_found" } }, 404);
  }) as unknown as typeof fetch;
  await clearSession();
});

describe("HomeScreen", () => {
  it("shows the pond, the gate, the profile and the photos, and the two buttons at the top", async () => {
    await renderWithTheme(<HomeScreen />);
    expect(screen.getByRole("heading", { name: "Kuutti" })).toBeTruthy();
    // Both cards have fetched and painted before anything is pressed.
    expect(await screen.findByText("Otaniemi")).toBeTruthy();
    expect(
      await screen.findByText("About 20 more people are needed before matching opens for you."),
    ).toBeTruthy();
    const user = userEvent.setup();
    await user.press(screen.getByRole("button", { name: "Your profile" }));
    await user.press(screen.getByRole("button", { name: "Your photos" }));
    await user.press(screen.getByRole("button", { name: "Settings" }));
    // A dev build: the technical view is one tap away; a store build has no such button.
    await user.press(screen.getByRole("button", { name: "Tech config" }));
    expect(router.push.mock.calls.map((c) => c[0])).toEqual([
      "/profile",
      "/photos",
      "/settings",
      "/tech",
    ]);
    // Nothing of the old smoke screen: no API card, no Retry.
    expect(screen.queryByText(/git commit/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
  });

  it("offers to check again when the account setup could not be read, and shows nothing that needs it", async () => {
    mockGate = { status: "unknown" };
    await renderWithTheme(<HomeScreen />);
    expect(screen.getByText("Your account setup could not be checked.")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Check again" }));
    expect(mockRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Your profile" })).toBeNull();
    expect(screen.queryByText("Otaniemi")).toBeNull();
  });

  it("says that it is checking while the status is in flight", async () => {
    mockGate = { status: "checking" };
    await renderWithTheme(<HomeScreen />);
    expect(screen.getByText("Checking your account setup…")).toBeTruthy();
  });
});

describe("HomeRoute", () => {
  it("is the sign-in screen for a signed-out person: one button and the bank", async () => {
    await renderWithTheme(<HomeRoute />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Kuutti" })).toBeNull();
  });

  it("is the home screen for a signed-in person", async () => {
    await saveSession(tokens);
    await renderWithTheme(<HomeRoute />);
    expect(await screen.findByRole("heading", { name: "Kuutti" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with your bank" })).toBeNull();
  });
});
