import { CONSENT_VERSIONS } from "@kuutti/i18n";
import type { GateResponse, PondSummary, WaitlistResponse } from "@kuutti/schema";
import { fireEvent, screen, userEvent, within } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import * as React from "react";
import { useSession } from "@/features/identity";
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
  refreshToken: `${token("family")}.${token("refresh")}`,
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
  it("shows the pond, the gate and the profile, and the two buttons at the top", async () => {
    await renderWithTheme(<HomeScreen />);
    expect(screen.getByRole("heading", { name: "Kuutti" })).toBeTruthy();
    // Both cards have fetched and painted before anything is pressed.
    expect(await screen.findByText("Otaniemi")).toBeTruthy();
    expect(
      await screen.findByText("About 20 more people are needed before matching opens for you."),
    ).toBeTruthy();
    const user = userEvent.setup();
    await user.press(screen.getByRole("button", { name: "Your profile" }));
    await user.press(screen.getByRole("button", { name: "Settings" }));
    // A dev build: the technical view is one tap away; a store build has no such button.
    await user.press(screen.getByRole("button", { name: "Tech config" }));
    expect(router.push.mock.calls.map((c) => c[0])).toEqual(["/profile", "/settings", "/tech"]);
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
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(mockRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Your profile" })).toBeNull();
    expect(screen.queryByText("Otaniemi")).toBeNull();
  });

  it("leaves the photos, the later questions and the deal-breakers to the profile, which holds them (#239)", async () => {
    await renderWithTheme(<HomeScreen />);
    expect(await screen.findByRole("button", { name: "Your profile" })).toBeTruthy();
    for (const name of ["Your photos", "Fill in the rest while you wait", "Your deal-breakers"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("shows the profile but no pond before the account has one", async () => {
    mockGate = { status: "complete", pond: null };
    await renderWithTheme(<HomeScreen />);
    expect(screen.getByRole("button", { name: "Your profile" })).toBeTruthy();
    expect(screen.queryByText("Otaniemi")).toBeNull();
    expect(screen.queryByText(/more people are needed/)).toBeNull();
  });

  it("leads to today's round from the gate card once matching is open, and not before (#379)", async () => {
    await renderWithTheme(<HomeScreen />);
    expect(
      await screen.findByText("About 20 more people are needed before matching opens for you."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Today's round" })).toBeNull();

    (globalThis.fetch as jest.Mock).mockImplementation(async (input: Request | string) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/waitlist") return json(waitlist);
      if (url.pathname === "/gate")
        return json({ state: "open", within: null, needed: null, step: 10 });
      return json({ error: { code: "not_found" } }, 404);
    });
    await renderWithTheme(<HomeScreen />);
    const round = await screen.findByRole("button", { name: "Today's round" });
    expect(screen.getByText("Matching is open for you.")).toBeTruthy();
    await userEvent.setup().press(round);
    expect(router.push).toHaveBeenCalledWith("/round");
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
  });

  it("offers notifications in the gate card once matching is open, never before (#102)", async () => {
    // A phone never asked, an offer never answered: the jest.setup.js defaults.
    const heading = "Shall Kuutti tell you?";
    await renderWithTheme(<HomeScreen />);
    expect(
      await screen.findByText("About 20 more people are needed before matching opens for you."),
    ).toBeTruthy();
    expect(screen.queryByText(heading)).toBeNull();

    (globalThis.fetch as jest.Mock).mockImplementation(async (input: Request | string) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/waitlist") return json(waitlist);
      if (url.pathname === "/gate")
        return json({ state: "open", within: null, needed: null, step: 10 });
      return json({ error: { code: "not_found" } }, 404);
    });
    await renderWithTheme(<HomeScreen />);
    expect(await screen.findByText(heading)).toBeTruthy();
    const card = screen.getByLabelText("When matching opens for you");
    expect(within(card).getByRole("button", { name: "Today's round" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Allow notifications" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "No thanks" })).toBeTruthy();
  });

  it("says that it is checking while the status is in flight", async () => {
    mockGate = { status: "checking" };
    await renderWithTheme(<HomeScreen />);
    expect(screen.getByText("Checking your account setup…")).toBeTruthy();
  });
});

describe("HomeRoute", () => {
  const { __store: store } = jest.requireMock("expo-secure-store") as {
    __store: Map<string, string>;
  };
  const AGREED = "kuutti.preference.agreedVersions";
  afterEach(() => store.delete(AGREED));

  it("is the sign-in screen for a signed-out person: one button and the bank", async () => {
    // A phone that recorded the wordings it carries after an earlier bank login (#418).
    store.set(
      AGREED,
      JSON.stringify({ terms: CONSENT_VERSIONS.terms, privacy: CONSENT_VERSIONS.privacy }),
    );
    await renderWithTheme(<HomeRoute />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Kuutti" })).toBeNull();
  });

  it("is the screens before the bank for a signed-out person on a phone that never answered them", async () => {
    await renderWithTheme(<HomeRoute />);
    expect(await screen.findByRole("heading", { name: "Before you sign in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "I'm in, and I accept both" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with your bank" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Kuutti" })).toBeNull();
  });

  it("is the home screen for a signed-in person", async () => {
    await saveSession(tokens);
    await renderWithTheme(<HomeRoute />);
    expect(await screen.findByRole("heading", { name: "Kuutti" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with your bank" })).toBeNull();
  });

  /** A login from the sign-in screen with the outcome the API gives it (#170). */
  function loginAnswering(outcome: string) {
    (globalThis.fetch as jest.Mock).mockImplementation(async (input: Request | string) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/auth/exchange") return json({ ...tokens, outcome });
      if (url.pathname === "/waitlist") return json(waitlist);
      if (url.pathname === "/gate") return json(gate);
      return json({ error: { code: "not_found" } }, 404);
    });
    return function Returning() {
      const { status, signIn } = useSession();
      React.useEffect(() => {
        if (status === "signed-out") void signIn("c".repeat(43), "5a1e".repeat(16));
      }, [status, signIn]);
      return <HomeRoute />;
    };
  }

  it("welcomes the person back once after a login that ended a break", async () => {
    const Returning = loginAnswering("unpaused");
    await renderWithTheme(<Returning />);
    expect(await screen.findByText("Welcome back. Your profile is visible again.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Kuutti" })).toBeTruthy();
  });

  it("says nothing of a break after an ordinary login", async () => {
    const Returning = loginAnswering("resumed");
    await renderWithTheme(<Returning />);
    expect(await screen.findByRole("heading", { name: "Kuutti" })).toBeTruthy();
    expect(screen.queryByText(/Welcome back/)).toBeNull();
  });

  it("shows only that it is loading while the stored session is read", async () => {
    // The session's read alone never answers: the lock and the preferences read the same store.
    const getItem = SecureStore.getItemAsync as jest.Mock;
    const original = getItem.getMockImplementation() as (key: string) => Promise<string | null>;
    getItem.mockImplementation((key: string) =>
      key === "kuutti.session" ? new Promise(() => undefined) : original(key),
    );
    try {
      await renderWithTheme(<HomeRoute />);
      expect(screen.getByText("Loading…")).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
    } finally {
      getItem.mockImplementation(original);
    }
  });
});
