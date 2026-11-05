import { CONSENT_VERSIONS } from "@kuutti/i18n";
import type { GateResponse, PondCounterResponse, PondSummary } from "@kuutti/schema";
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
let mockGate: { status: "checking" } | { status: "unknown" } | { status: "complete" };
jest.mock("@/features/identity", () => ({
  ...jest.requireActual("@/features/identity"),
  useOnboardingGate: () => ({ ...mockGate, retry: mockRetry }),
}));
const mockRetry = jest.fn();
// A dev build unless a test says it is the store's.
let mockProduction = false;
jest.mock("@/lib/environment", () => ({
  ...jest.requireActual("@/lib/environment"),
  isProduction: () => mockProduction,
}));

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock };
};

/** The two places of the row above the screen, left to right, as drawn. */
function topRow(): HostNode[] {
  const find = (node: HostNode | string): HostNode | null => {
    if (typeof node === "string") return null;
    if (String(node.props.className ?? "").startsWith("flex-row justify-between")) return node;
    for (const child of node.children ?? []) {
      const found = find(child);
      if (found) return found;
    }
    return null;
  };
  const row = find(screen.toJSON() as HostNode);
  return (row?.children ?? []).filter((child): child is HostNode => typeof child !== "string");
}

const POND: PondSummary = {
  id: "0b4f3a0e-7c2f-4e2b-9a9a-1a2b3c4d5e6f",
  slug: "suomi",
  name: "Suomi",
};
const counter: PondCounterResponse = {
  k: 10,
  ponds: [
    { pond: POND, day: "2026-10-05", verified: 150, split: null, finishing: null, seeks: null },
  ],
};
const gate: GateResponse = { state: "closed" };
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
  mockProduction = false;
  mockGate = { status: "complete" };
  globalThis.fetch = jest.fn(async (input: Request | string) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/ponds/counter") return json(counter);
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
    expect(await screen.findByText("People on Kuutti")).toBeTruthy();
    expect(
      await screen.findByText("Your profile is finished. Matching has not opened yet."),
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

  it("puts the wrench on the left and the gear on the right (#511)", async () => {
    await renderWithTheme(<HomeScreen />);
    expect(topRow().map((place) => place.props.accessibilityLabel)).toEqual([
      "Tech config",
      "Settings",
    ]);
  });

  it("keeps the gear on the right in production, alone", async () => {
    mockProduction = true;
    await renderWithTheme(<HomeScreen />);
    expect(screen.queryByRole("button", { name: "Tech config" })).toBeNull();
    expect(topRow().map((place) => place.props.accessibilityLabel)).toEqual([
      undefined,
      "Settings",
    ]);
  });

  it("offers to check again when the account setup could not be read, and shows nothing that needs it", async () => {
    mockGate = { status: "unknown" };
    await renderWithTheme(<HomeScreen />);
    expect(screen.getByText("Your account setup could not be checked.")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(mockRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Your profile" })).toBeNull();
    expect(screen.queryByText("People on Kuutti")).toBeNull();
  });

  it("leaves the photos, the later questions and what one seeks to the profile, which holds them (#239, ADR-062 §11)", async () => {
    await renderWithTheme(<HomeScreen />);
    expect(await screen.findByRole("button", { name: "Your profile" })).toBeTruthy();
    for (const name of [
      "Your photos",
      "Fill in the rest when you have a moment",
      "What you seek",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("leads to the queue from the gate card once matching is open, and not before (#379)", async () => {
    await renderWithTheme(<HomeScreen />);
    expect(
      await screen.findByText("Your profile is finished. Matching has not opened yet."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "See people" })).toBeNull();

    (globalThis.fetch as jest.Mock).mockImplementation(async (input: Request | string) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/ponds/counter") return json(counter);
      if (url.pathname === "/gate") return json({ state: "open" });
      return json({ error: { code: "not_found" } }, 404);
    });
    await renderWithTheme(<HomeScreen />);
    const round = await screen.findByRole("button", { name: "See people" });
    expect(screen.getByText("Matching is open for you.")).toBeTruthy();
    await userEvent.setup().press(round);
    expect(router.push).toHaveBeenCalledWith("/round");
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
  });

  it("offers the people the person starred beside the way to the queue, once matching is open and while there are any (#575)", async () => {
    const answering = (items: unknown[]) => async (input: Request | string) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/ponds/counter") return json(counter);
      if (url.pathname === "/gate") return json({ state: "open" });
      if (url.pathname === "/stars") return json({ items });
      return json({ error: { code: "not_found" } }, 404);
    };
    (globalThis.fetch as jest.Mock).mockImplementation(answering([]));
    await renderWithTheme(<HomeScreen />);
    await screen.findByRole("button", { name: "See people" });
    expect(screen.queryByRole("button", { name: "Starred" })).toBeNull();

    (globalThis.fetch as jest.Mock).mockImplementation(
      answering([
        { id: "7a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01", name: "Katja", age: 44, photo: null },
      ]),
    );
    await renderWithTheme(<HomeScreen />);
    await userEvent.setup().press(await screen.findByRole("button", { name: "Starred" }));
    expect(router.push).toHaveBeenCalledWith("/stars");
  });

  it("offers notifications in the gate card once matching is open, never before (#102)", async () => {
    // A phone never asked, an offer never answered: the jest.setup.js defaults.
    const heading = "Shall Kuutti tell you?";
    await renderWithTheme(<HomeScreen />);
    expect(
      await screen.findByText("Your profile is finished. Matching has not opened yet."),
    ).toBeTruthy();
    expect(screen.queryByText(heading)).toBeNull();

    (globalThis.fetch as jest.Mock).mockImplementation(async (input: Request | string) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/ponds/counter") return json(counter);
      if (url.pathname === "/gate") return json({ state: "open" });
      return json({ error: { code: "not_found" } }, 404);
    });
    await renderWithTheme(<HomeScreen />);
    expect(await screen.findByText(heading)).toBeTruthy();
    // The matching card: the least that holds its sentence and See people.
    let card = screen.getByText("Matching is open for you.");
    while (within(card).queryByRole("button", { name: "See people" }) === null && card.parent) {
      card = card.parent;
    }
    expect(within(card).queryByText("People on Kuutti")).toBeNull();
    expect(within(card).getByRole("button", { name: "See people" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Allow notifications" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "No thanks" })).toBeTruthy();
  });

  describe("the order of the screen (#581)", () => {
    /** Everything the screen draws, in the order it is read. */
    const said = (node: HostNode | string = screen.toJSON() as HostNode): string[] =>
      typeof node === "string" ? [node] : (node.children ?? []).flatMap((child) => said(child));
    const COUNTER = "People on Kuutti";
    const star = {
      id: "7a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01",
      name: "Katja",
      age: 44,
      photo: null,
    };
    const warned = {
      id: "00000000-0000-4000-8000-000000000001",
      kind: "warning",
      at: "2026-10-18T09:00:00.000Z",
      readAt: null,
      reason: "harassment",
    };
    const answering = (state: GateResponse["state"], notices: unknown[] = []) =>
      (globalThis.fetch as jest.Mock).mockImplementation(async (input: Request | string) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname === "/ponds/counter") return json(counter);
        if (url.pathname === "/gate") return json({ state });
        if (url.pathname === "/stars") return json({ items: [star] });
        if (url.pathname === "/notices") return json({ notices });
        return json({ error: { code: "not_found" } }, 404);
      });

    it("has what there is to do first and how many are on Kuutti last, once matching is open", async () => {
      answering("open");
      await renderWithTheme(<HomeScreen />);
      await screen.findByRole("button", { name: "Starred" });
      await screen.findByText(COUNTER);
      // Each way on before the counter, the offer of notifications inside the gate card.
      const order = [
        "Matching is open for you.",
        "See people",
        "Starred",
        "Shall Kuutti tell you?",
        "Your profile",
        "Conversations",
        COUNTER,
      ];
      expect(said().filter((word) => order.includes(word))).toEqual(order);
    });

    it.each([
      ["closed", "Your profile is finished. Matching has not opened yet."],
      ["incomplete", "Matching opens for finished profiles. Yours still lacks something."],
    ] as const)("keeps the order with matching %s", async (state, sentence) => {
      answering(state);
      await renderWithTheme(<HomeScreen />);
      await screen.findByText(sentence);
      await screen.findByText(COUNTER);
      const shown = said().filter((word) =>
        [sentence, "Your profile", "Conversations", COUNTER].includes(word),
      );
      expect(shown).toEqual([sentence, "Your profile", "Conversations", COUNTER]);
    });

    it("keeps an unread notice above everything, as what must reach the person first", async () => {
      answering("open", [warned]);
      await renderWithTheme(<HomeScreen />);
      await screen.findByRole("heading", { name: "Notices" });
      await screen.findByRole("button", { name: "See people" });
      await screen.findByText(COUNTER);
      const words = said();
      expect(words.indexOf("Notices")).toBeLessThan(words.indexOf("Matching is open for you."));
      expect(words.indexOf("Matching is open for you.")).toBeLessThan(words.indexOf(COUNTER));
    });
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
    expect(await screen.findByRole("heading", { name: "How we do things here" })).toBeTruthy();
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
      if (url.pathname === "/ponds/counter") return json(counter);
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
