import { createHash } from "node:crypto";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as React from "react";
import { Linking, Platform } from "react-native";
import { apiBaseUrl } from "@/lib/api";
import { LocaleProvider } from "@/lib/locale";
import { clearSession, currentSession, markLoginStarted, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import { SignInScreen } from "./SignInScreen";
import { SessionProvider, useSession } from "./session";

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock; setParams: jest.Mock };
};

const CODE = "c".repeat(43);
// Any well-formed verifier of the attempt (ADR-027): 64 lowercase hex characters.
const VERIFIER = "5a1e".repeat(16);
const HEX_64 = /^[0-9a-f]{64}$/;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
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

/** The /auth/start URL the button opened last, with its challenge taken apart (ADR-027). */
function lastStart(openURL: jest.SpyInstance): { url: string; challenge: string | undefined } {
  const [url = "", challenge] = String(openURL.mock.calls.at(-1)?.[0]).split("&code_challenge=");
  return { url, challenge };
}

/** Presses the sign-in button and answers the challenge of the start it opened. */
async function pressStart(openURL: jest.SpyInstance): Promise<string | undefined> {
  const before = openURL.mock.calls.length;
  await fireEvent.press(screen.getByRole("button", { name: "Sign in with your bank" }));
  await waitFor(() => expect(openURL).toHaveBeenCalledTimes(before + 1));
  return lastStart(openURL).challenge;
}

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

  it("says the account is on a break right after this device paused it, and the way back", async () => {
    await saveSession(tokens);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    // The screen as the provider shows it once the break began on this device (#170).
    function Pausing() {
      const session = useSession();
      const { status, pauseAccount } = session;
      React.useEffect(() => {
        if (status === "signed-in") void pauseAccount();
      }, [status, pauseAccount]);
      return <SignInScreen />;
    }
    await renderWithTheme(<Pausing />);
    expect(await screen.findByText("Your account is on a break")).toBeTruthy();
    expect(screen.getByText(/Sign in with your bank whenever you want to come back/)).toBeTruthy();
    expect(currentSession()).toBeNull();
    // The way back is the same button as always.
    expect(screen.getByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
  });

  it("says nothing of a break to a device that was simply signed out", async () => {
    await renderWithTheme(<SignInScreen />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText("Your account is on a break")).toBeNull();
  });

  it("opens the system browser at the API's /auth/start for this platform", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await renderWithTheme(<SignInScreen />);
    await fireEvent.press(screen.getByRole("button", { name: "Sign in with your bank" }));
    expect(lastStart(openURL)).toEqual({
      url: `${apiBaseUrl()}/auth/start?platform=ios&locale=en`,
      challenge: expect.stringMatching(HEX_64),
    });
    expect(await screen.findByText(/Your bank opens in the browser/)).toBeTruthy();
  });

  it("starts with the SHA-256 of a fresh verifier each time, and exchanges the code with the latest one", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    fetchMock.mockResolvedValueOnce(json(tokens));
    const view = await renderWithTheme(<SignInScreen />);
    const first = await pressStart(openURL);
    // A second tap, as when the first browser tab was lost: a new attempt.
    const second = await pressStart(openURL);
    expect(first).toMatch(HEX_64);
    expect(second).toMatch(HEX_64);
    expect(second).not.toBe(first);

    await view.rerender(underProviders(<SignInScreen code={CODE} />));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    const sent = fetchMock.mock.calls[0]?.[0] as Request;
    const body = JSON.parse(await sent.text());
    expect(body).toEqual({ code: CODE, verifier: expect.stringMatching(HEX_64) });
    // The verifier is the one whose hash the latest start carried; the deep link never had it.
    expect(sha256(body.verifier)).toBe(second);
    expect(currentSession()?.sessionId).toBe(tokens.sessionId);
  });

  it("shows the words for a used code when the API refuses the code for its verifier", async () => {
    // The API binds each code to its attempt's challenge: here the code came
    // back from the first of two starts, so the latest verifier does not fit.
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    const view = await renderWithTheme(<SignInScreen />);
    const first = await pressStart(openURL);
    expect(first).toMatch(HEX_64);
    await pressStart(openURL);
    fetchMock.mockImplementationOnce(async (request) => {
      const { verifier } = JSON.parse(await (request as Request).text());
      return sha256(verifier) === first
        ? json(tokens)
        : json({ error: { code: "auth_code_used", message: "x", requestId: "r" } }, 401);
    });

    await view.rerender(underProviders(<SignInScreen code={CODE} />));
    expect(await screen.findByText(/already used or has expired/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(currentSession()).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("exchanges the code the deep link carried, keeps the session and goes home", async () => {
    await markLoginStarted(VERIFIER);
    fetchMock.mockResolvedValueOnce(json(tokens));
    await renderWithTheme(<SignInScreen code={CODE} />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    const sent = fetchMock.mock.calls[0]?.[0] as Request;
    expect(sent.url).toBe(`${apiBaseUrl()}/auth/exchange`);
    expect(JSON.parse(await sent.text())).toEqual({ code: CODE, verifier: VERIFIER });
    expect(currentSession()?.sessionId).toBe(tokens.sessionId);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("refuses a code for a login this phone did not start", async () => {
    await renderWithTheme(<SignInScreen code={CODE} />);
    expect(await screen.findByText(/was not requested from this phone/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a code that arrives while the phone is signed in", async () => {
    await markLoginStarted(VERIFIER);
    const { outcome: _outcome, ...stored } = tokens;
    await saveSession(stored);
    await renderWithTheme(<SignInScreen code={CODE} />);
    expect(await screen.findByText(/was not requested from this phone/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(currentSession()?.sessionId).toBe(tokens.sessionId); // untouched
  });

  it("forgets a login it started after ten minutes", async () => {
    await markLoginStarted(VERIFIER, Date.now() - 11 * 60 * 1000);
    await renderWithTheme(<SignInScreen code={CODE} />);
    expect(await screen.findByText(/was not requested from this phone/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a used code as such and offers to start again", async () => {
    await markLoginStarted(VERIFIER);
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: "auth_code_used", message: "x", requestId: "r" } }, 401),
    );
    await renderWithTheme(<SignInScreen code={CODE} />);
    expect(await screen.findByText(/already used or has expired/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(currentSession()).toBeNull();
  });

  it.each([
    ["en-US", "Too many sign-ins were started just now. Wait a minute and try again."],
    [
      "fi-FI",
      "Kirjautumisia on juuri nyt aloitettu liian monta. Odota minuutti ja yritä uudelleen.",
    ],
    ["sv-FI", "Just nu har för många inloggningar påbörjats. Vänta en minut och försök igen."],
  ])(
    "says a start refused for the sign-in's rate in words on a %s phone (ADR-026 §4)",
    async (languageTag, text) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
      try {
        await renderWithTheme(<SignInScreen error="auth_rate_limited" />);
        expect(await screen.findByText(text)).toBeTruthy();
        expect(screen.getAllByRole("button")).toHaveLength(1);
        // The code itself is never shown.
        expect(screen.queryByText(/auth_rate_limited/)).toBeNull();
      } finally {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
      }
    },
  );

  it("says the same wait when the exchange is refused for the rate, and keeps no session", async () => {
    await markLoginStarted(VERIFIER);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: "rate_limited", message: "x", requestId: "r" } }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "42" } },
      ),
    );
    await renderWithTheme(<SignInScreen code={CODE} />);
    expect(
      await screen.findByText(
        "Too many sign-ins were started just now. Wait a minute and try again.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("Something went wrong. Try again.")).toBeNull();
    expect(currentSession()).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
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

  it("names the day a suspension ends, the start of that day in Finland", async () => {
    // Midnight in Finland in summer time (ADR-024 §5), as the API sends it.
    await renderWithTheme(<SignInScreen error="auth_suspended" until="2026-10-21T21:00:00.000Z" />);
    expect(
      await screen.findByText("This account is suspended. You can sign in again from: 22.10.2026"),
    ).toBeTruthy();
    expect(screen.queryByText("This account is suspended for now.")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("reads the suspension's day in Finland's zone, whatever the phone's", async () => {
    // The test process keeps the machine's zone (UTC on CI). Just after
    // midnight in Finland is still the day before in UTC and anywhere west;
    // just before midnight is already the next day anywhere east.
    const view = await renderWithTheme(
      <SignInScreen error="auth_suspended" until="2026-10-21T21:30:00.000Z" />,
    );
    expect(await screen.findByText(/You can sign in again from: 22\.10\.2026$/)).toBeTruthy();
    // Winter time: midnight is 22:00 UTC.
    await view.rerender(
      underProviders(<SignInScreen error="auth_suspended" until="2026-11-08T22:00:00.000Z" />),
    );
    expect(await screen.findByText(/You can sign in again from: 9\.11\.2026$/)).toBeTruthy();
    await view.rerender(
      underProviders(<SignInScreen error="auth_suspended" until="2026-11-08T21:59:59.999Z" />),
    );
    expect(await screen.findByText(/You can sign in again from: 8\.11\.2026$/)).toBeTruthy();
  });

  it.each([
    ["fi-FI", "Tämä tili on jäädytetty. Voit kirjautua taas sisään alkaen: 9.11.2026"],
    ["sv-FI", "Det här kontot är avstängt. Du kan logga in igen från och med: 9.11.2026"],
  ])("names the suspension's day on a %s phone in its language", async (languageTag, text) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
    try {
      await renderWithTheme(
        <SignInScreen error="auth_suspended" until="2026-11-08T22:00:00.000Z" />,
      );
      expect(await screen.findByText(text)).toBeTruthy();
    } finally {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
    }
  });

  it("says the plain sentence for a suspension whose link carries no day, or one that is not a date", async () => {
    const view = await renderWithTheme(<SignInScreen error="auth_suspended" />);
    expect(await screen.findByText("This account is suspended for now.")).toBeTruthy();
    await view.rerender(
      underProviders(<SignInScreen error="auth_suspended" until="2026-10-21T21:00:00.000Z" />),
    );
    expect(await screen.findByText(/You can sign in again from: 22\.10\.2026$/)).toBeTruthy();
    await view.rerender(underProviders(<SignInScreen error="auth_suspended" until="not a date" />));
    expect(await screen.findByText("This account is suspended for now.")).toBeTruthy();
    await view.rerender(underProviders(<SignInScreen error="auth_suspended" until="" />));
    expect(await screen.findByText("This account is suspended for now.")).toBeTruthy();
    expect(screen.queryByText(/You can sign in again from/)).toBeNull();
  });

  it("names no day for a ban, whatever day its link carries", async () => {
    await renderWithTheme(<SignInScreen error="auth_banned" until="2026-10-21T21:00:00.000Z" />);
    expect(await screen.findByText("This person may not use Kuutti.")).toBeTruthy();
    expect(screen.queryByText(/22\.10\.2026/)).toBeNull();
  });

  it("says so when the API has no bank, as a pull-request preview has none", async () => {
    await renderWithTheme(<SignInScreen error="auth_unavailable" />);
    expect(await screen.findByText(/There is no bank sign-in here/)).toBeTruthy();
  });

  it("on the web, says there is no bank sign-in instead of offering a button", async () => {
    // Without ThemeProvider: its web path sets the colour scheme on a DOM
    // that jest-expo's iOS preset does not have.
    const os = jest.replaceProperty(Platform, "OS", "web");
    try {
      await render(
        <LocaleProvider>
          <SessionProvider>
            <SignInScreen />
          </SessionProvider>
        </LocaleProvider>,
      );
      expect(await screen.findByText(/There is no bank sign-in here/)).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
    } finally {
      os.restore();
    }
  });

  it("shows the generic text for a code it has no words for", async () => {
    await renderWithTheme(<SignInScreen error="something_else" />);
    expect(await screen.findByText("Something went wrong. Try again.")).toBeTruthy();
  });

  it("treats a prototype member name in the link as a code it has no words for", async () => {
    await renderWithTheme(<SignInScreen error="toString" />);
    expect(await screen.findByText("Something went wrong. Try again.")).toBeTruthy();
  });

  it("marks the login as started, with its verifier, when the button is pressed", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await renderWithTheme(<SignInScreen />);
    await fireEvent.press(await screen.findByRole("button", { name: "Sign in with your bank" }));
    // The mark is written before the browser opens.
    await waitFor(() => expect(openURL).toHaveBeenCalled());
    const { takeLoginStarted } = jest.requireActual(
      "@/lib/session",
    ) as typeof import("@/lib/session");
    const verifier = await takeLoginStarted();
    expect(verifier).toMatch(HEX_64);
    expect(sha256(String(verifier))).toBe(lastStart(openURL).challenge);
    expect(await takeLoginStarted()).toBeNull(); // once
  });

  it("says something went wrong when the exchange fails without a word from the API", async () => {
    await markLoginStarted(VERIFIER);
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    await renderWithTheme(<SignInScreen code={CODE} />);
    expect(await screen.findByText("Something went wrong. Try again.")).toBeTruthy();
    expect(currentSession()).toBeNull();
  });

  it("asks for the bank's chooser in the app's language", async () => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: "sv-FI" }]);
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    try {
      await renderWithTheme(<SignInScreen />);
      await fireEvent.press(await screen.findByRole("button", { name: "Logga in med din bank" }));
      expect(lastStart(openURL)).toEqual({
        url: `${apiBaseUrl()}/auth/start?platform=ios&locale=sv`,
        challenge: expect.stringMatching(HEX_64),
      });
    } finally {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
      openURL.mockRestore();
    }
  });

  it("says something went wrong when the browser cannot be opened, and offers to try again", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockRejectedValue(new Error("no browser"));
    try {
      await renderWithTheme(<SignInScreen />);
      await fireEvent.press(screen.getByRole("button", { name: "Sign in with your bank" }));
      expect(await screen.findByText("Something went wrong. Try again.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    } finally {
      openURL.mockRestore();
    }
  });

  it("names no day for a cooldown whose link carries none, or one that is not a date", async () => {
    const view = await renderWithTheme(<SignInScreen error="auth_cooldown" />);
    expect(
      await screen.findByText(
        "You deleted your account recently. The earliest day for a new one: ",
      ),
    ).toBeTruthy();
    await view.rerender(underProviders(<SignInScreen error="auth_cooldown" until="not a date" />));
    expect(
      await screen.findByText(
        "You deleted your account recently. The earliest day for a new one: ",
      ),
    ).toBeTruthy();
  });
});
