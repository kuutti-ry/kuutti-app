import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { apiBaseUrl } from "@/lib/api";
import { clearSession, currentSession, markLoginStarted, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import { SignInScreen } from "./SignInScreen";

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock; setParams: jest.Mock };
};

const CODE = "c".repeat(43);
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const tokens = {
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token("access"),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: token("refresh"),
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  outcome: "created",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = jest.fn<Promise<Response>, [Request | string]>();

beforeEach(async () => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  router.replace.mockReset();
  router.setParams.mockReset();
  await clearSession();
});

describe("SignInScreen", () => {
  it("has a heading, an explanation and one labelled button, with no accessibility problems", async () => {
    await renderWithTheme(<SignInScreen />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByText(/Kuutti verifies every account through a Finnish bank/)).toBeTruthy();
    const found = pressables(screen.toJSON() as HostNode);
    expect(found).toHaveLength(1);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  });

  it("opens the system browser at the API's /auth/start for this platform", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await renderWithTheme(<SignInScreen />);
    await fireEvent.press(screen.getByRole("button", { name: "Sign in with your bank" }));
    expect(openURL).toHaveBeenCalledWith(`${apiBaseUrl()}/auth/start?platform=ios`);
    expect(await screen.findByText(/Your bank opens in the browser/)).toBeTruthy();
  });

  it("exchanges the code the deep link carried, keeps the session and goes home", async () => {
    await markLoginStarted();
    fetchMock.mockResolvedValueOnce(json(tokens));
    await renderWithTheme(<SignInScreen code={CODE} />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    const sent = fetchMock.mock.calls[0]?.[0] as Request;
    expect(sent.url).toBe(`${apiBaseUrl()}/auth/exchange`);
    expect(JSON.parse(await sent.text())).toEqual({ code: CODE });
    expect(currentSession()?.sessionId).toBe(tokens.sessionId);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("refuses a code for a login this phone did not start", async () => {
    await renderWithTheme(<SignInScreen code={CODE} />);
    expect(await screen.findByText(/was not requested from this phone/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a code that arrives while the phone is signed in", async () => {
    await markLoginStarted();
    const { outcome: _outcome, ...stored } = tokens;
    await saveSession(stored);
    await renderWithTheme(<SignInScreen code={CODE} />);
    expect(await screen.findByText(/was not requested from this phone/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(currentSession()?.sessionId).toBe(tokens.sessionId); // untouched
  });

  it("forgets a login it started after ten minutes", async () => {
    await markLoginStarted(Date.now() - 11 * 60 * 1000);
    await renderWithTheme(<SignInScreen code={CODE} />);
    expect(await screen.findByText(/was not requested from this phone/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a used code as such and offers to start again", async () => {
    await markLoginStarted();
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: "auth_code_used", message: "x", requestId: "r" } }, 401),
    );
    await renderWithTheme(<SignInScreen code={CODE} />);
    expect(await screen.findByText(/already used or has expired/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(currentSession()).toBeNull();
  });

  it("shows the refusal the deep link carried", async () => {
    await renderWithTheme(<SignInScreen error="auth_under_18" />);
    expect(
      await screen.findByText("Kuutti is for adults. You are welcome once you are 18."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows a refusal that arrives while the screen is shown, after another try", async () => {
    jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    const view = await renderWithTheme(<SignInScreen error="auth_under_18" />);
    expect(
      await screen.findByText("Kuutti is for adults. You are welcome once you are 18."),
    ).toBeTruthy();

    // Another try: the bank opens, and what the last link said is put away.
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Your bank opens in the browser/)).toBeTruthy();
    expect(router.setParams).toHaveBeenCalledWith({
      code: undefined,
      error: undefined,
      until: undefined,
    });
    await view.rerender(underProviders(<SignInScreen />));
    expect(screen.getByText(/Your bank opens in the browser/)).toBeTruthy();

    // The link comes back to the same screen with another refusal.
    await view.rerender(underProviders(<SignInScreen error="auth_banned" />));
    expect(await screen.findByText("This person may not use Kuutti.")).toBeTruthy();
    expect(screen.queryByText(/Your bank opens in the browser/)).toBeNull();

    // And with the same one again, after one more try.
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await view.rerender(underProviders(<SignInScreen />));
    expect(await screen.findByText(/Your bank opens in the browser/)).toBeTruthy();
    await view.rerender(underProviders(<SignInScreen error="auth_banned" />));
    expect(await screen.findByText("This person may not use Kuutti.")).toBeTruthy();
  });

  it("shows the cooldown with its date in the app's locale", async () => {
    await renderWithTheme(<SignInScreen error="auth_cooldown" until="2026-10-22T10:00:00.000Z" />);
    expect(await screen.findByText(/The earliest day for a new one: 22.10.2026/)).toBeTruthy();
  });

  it("shows the generic text for a code it has no words for", async () => {
    await renderWithTheme(<SignInScreen error="something_else" />);
    expect(await screen.findByText("Something went wrong. Try again.")).toBeTruthy();
  });

  it("treats a prototype member name in the link as a code it has no words for", async () => {
    await renderWithTheme(<SignInScreen error="toString" />);
    expect(await screen.findByText("Something went wrong. Try again.")).toBeTruthy();
  });

  it("marks the login as started when the button is pressed", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await renderWithTheme(<SignInScreen />);
    await fireEvent.press(await screen.findByRole("button", { name: "Sign in with your bank" }));
    // The mark is written before the browser opens.
    await waitFor(() => expect(openURL).toHaveBeenCalled());
    const { takeLoginStarted } = jest.requireActual(
      "@/lib/session",
    ) as typeof import("@/lib/session");
    expect(await takeLoginStarted()).toBe(true);
    expect(await takeLoginStarted()).toBe(false); // once
  });
});
