import { createHash } from "node:crypto";
import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import * as React from "react";
import { AppState, Linking, Platform } from "react-native";
import { apiBaseUrl } from "@/lib/api";
import { LocaleProvider } from "@/lib/locale";
import { clearSession, currentSession, markLoginStarted, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import { dropAgreements, heldAgreements, holdAgreements } from "./agreements";
import { SignInScreen } from "./SignInScreen";
import { SessionProvider, useSession } from "./session";

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock; setParams: jest.Mock };
};

/** Every text on the screen, in order. */
const drawn = () => screen.queryAllByText(/./).map((node) => node.props.children as unknown);
/** The screen with nothing to say: its title and its button, no line between them (#581). */
const READY = ["Sign in", "Sign in with your bank"];
/** The card of a refusal with no fact of its own: its title and Try again say it all (#581). */
const REFUSED = "Sign-in did not complete";
const BARE_REFUSAL = ["Sign in", REFUSED, "Try again"];
const NOT_REQUESTED = "This sign-in link was not requested from this phone.";
const UNDER_18 = "Kuutti is for adults. You are welcome once you are 18.";
/** The heading of the screen before the bank. */
const NORMS = "How we do things here";

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
  refreshToken: `${token("family")}.${token("refresh")}`,
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

const { __store: store } = jest.requireMock("expo-secure-store") as {
  __store: Map<string, string>;
};
const AGREED = "kuutti.preference.agreedVersions";
const TERMS = String(CONSENT_VERSIONS.terms);
const PRIVACY = String(CONSENT_VERSIONS.privacy);
const RESEARCH = String(CONSENT_VERSIONS.research);
/** This phone recorded the wordings it carries after an earlier bank login (#418): straight to the bank. */
const remember = () => store.set(AGREED, JSON.stringify({ terms: TERMS, privacy: PRIVACY }));

beforeEach(async () => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  router.replace.mockReset();
  router.setParams.mockReset();
  await clearSession();
  // A phone that never answered the screens before the bank, with nothing held from this run.
  store.delete(AGREED);
  dropAgreements();
  // Both are jest's own mocks already (react-native's setup, jest.setup.js), which
  // restoreAllMocks leaves alone: their calls are counted per test from here.
  jest.spyOn(Linking, "openURL").mockClear();
  (SecureStore.getItemAsync as jest.Mock).mockClear();
});
afterEach(() => jest.restoreAllMocks());

/** The screen as the provider shows it once the lock's way out was taken (#418). */
function Leaving() {
  const { status, signOut } = useSession();
  React.useEffect(() => {
    if (status === "signed-in") void signOut("lock");
  }, [status, signOut]);
  return <SignInScreen />;
}

describe("SignInScreen", () => {
  // The bank half of the sign-in, on a phone past the screens before it.
  beforeEach(remember);

  it("has a heading and one labelled button, nothing to read between them, with no accessibility problems (#581)", async () => {
    await renderWithTheme(<SignInScreen />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
    expect(drawn()).toEqual(READY);
    const found = pressables(screen.toJSON() as HostNode);
    expect(found).toHaveLength(1);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  });

  it("says the account is on a break right after this device paused it, the card's title alone, and the way back (#581)", async () => {
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
    expect(
      within(screen.getByLabelText("Your account is on a break"))
        .getAllByText(/./)
        .map((node) => node.props.children),
    ).toEqual(["Your account is on a break"]);
    expect(currentSession()).toBeNull();
    // The way back is the same button as always.
    expect(screen.getByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
  });

  it("says nothing of a break or of the lock to a device that was simply signed out", async () => {
    await saveSession(tokens);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    function LoggingOut() {
      const { status, signOut } = useSession();
      React.useEffect(() => {
        if (status === "signed-in") void signOut();
      }, [status, signOut]);
      return <SignInScreen />;
    }
    await renderWithTheme(<LoggingOut />);
    await waitFor(() => expect(currentSession()).toBeNull());
    expect(await screen.findByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
    expect(drawn()).toEqual(READY);
  });

  it("says the lock signed this phone out, that the lock is off now, and the way back", async () => {
    await saveSession(tokens);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await renderWithTheme(<Leaving />);
    expect(await screen.findByText("Signed out by the lock")).toBeTruthy();
    expect(screen.getByLabelText("Signed out by the lock")).toBeTruthy();
    expect(
      screen.getByText(
        "Nothing on your account changed. The lock is off until you turn it on again in Settings.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Your account is on a break")).toBeNull();
    expect(currentSession()).toBeNull();
    // The way back is the same button as always.
    expect(screen.getByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
  });

  it.each([
    [
      "fi-FI",
      "Lukitus kirjasi sinut ulos",
      "Tilillesi ei muuttunut mitään. Lukitus on pois päältä, kunnes otat sen taas käyttöön asetuksista.",
    ],
    [
      "sv-FI",
      "Låset loggade ut dig",
      "Ingenting ändrades på ditt konto. Låset är av tills du slår på det igen i inställningarna.",
    ],
  ])("says what the lock left behind on a %s phone (#581)", async (languageTag, title, body) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
    try {
      await saveSession(tokens);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await renderWithTheme(<Leaving />);
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByText(body)).toBeTruthy();
    } finally {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
    }
  });

  it("opens the system browser at the API's /auth/start for this platform", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await renderWithTheme(<SignInScreen />);
    await fireEvent.press(screen.getByRole("button", { name: "Sign in with your bank" }));
    expect(lastStart(openURL)).toEqual({
      url: `${apiBaseUrl()}/auth/start?platform=ios&locale=en`,
      challenge: expect.stringMatching(HEX_64),
    });
    // The browser covers the screen as it opens: no line goes stale under it, and the button is there on the way back (#581).
    expect(drawn()).toEqual(READY);
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

  it("says the sign-in did not complete when the API refuses the code for its verifier", async () => {
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
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    expect(drawn()).toEqual(BARE_REFUSAL);
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
    // What stands until home takes over, and a screen reader hears it: nothing says it is done (#581).
    expect(drawn()).toEqual(["Sign in", "Signing you in…"]);
    expect(screen.getByText("Signing you in…").props.accessibilityLiveRegion).toBe("polite");
  });

  it("refuses a code for a login this phone did not start", async () => {
    await renderWithTheme(<SignInScreen code={CODE} />);
    expect(await screen.findByText(NOT_REQUESTED)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a code that arrives while the phone is signed in", async () => {
    await markLoginStarted(VERIFIER);
    const { outcome: _outcome, ...stored } = tokens;
    await saveSession(stored);
    await renderWithTheme(<SignInScreen code={CODE} />);
    expect(await screen.findByText(NOT_REQUESTED)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(currentSession()?.sessionId).toBe(tokens.sessionId); // untouched
  });

  it("forgets a login it started after ten minutes", async () => {
    await markLoginStarted(VERIFIER, Date.now() - 11 * 60 * 1000);
    await renderWithTheme(<SignInScreen code={CODE} />);
    expect(await screen.findByText(NOT_REQUESTED)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says a used code did not complete the sign-in, the card's title alone, and offers to start again (#581)", async () => {
    await markLoginStarted(VERIFIER);
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: "auth_code_used", message: "x", requestId: "r" } }, 401),
    );
    await renderWithTheme(<SignInScreen code={CODE} />);
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    expect(drawn()).toEqual(BARE_REFUSAL);
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
    expect(currentSession()).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("shows the refusal the deep link carried", async () => {
    await renderWithTheme(<SignInScreen error="auth_under_18" />);
    expect(await screen.findByText(UNDER_18)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
  });

  it("shows a refusal that arrives while the screen is shown, after another try", async () => {
    jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    const view = await renderWithTheme(<SignInScreen error="auth_under_18" />);
    expect(await screen.findByText(UNDER_18)).toBeTruthy();

    // Another try: the bank opens, the refusal goes with it, and what the last link said is put away.
    await fireEvent.press(screen.getByRole("button", { name: "Sign in with your bank" }));
    await waitFor(() => expect(drawn()).toEqual(READY));
    expect(router.setParams).toHaveBeenCalledWith({
      code: undefined,
      error: undefined,
      until: undefined,
    });
    await view.rerender(underProviders(<SignInScreen />));
    expect(drawn()).toEqual(READY);

    // The link comes back to the same screen with another refusal.
    await view.rerender(underProviders(<SignInScreen error="auth_banned" />));
    expect(await screen.findByText("This person may not use Kuutti.")).toBeTruthy();

    // And with the same one again, after one more try.
    await fireEvent.press(screen.getByRole("button", { name: "Sign in with your bank" }));
    await view.rerender(underProviders(<SignInScreen />));
    await waitFor(() => expect(drawn()).toEqual(READY));
    await view.rerender(underProviders(<SignInScreen error="auth_banned" />));
    expect(await screen.findByText("This person may not use Kuutti.")).toBeTruthy();
  });

  describe("the refusals with no fact of their own (#581)", () => {
    it.each([
      ["auth_code_used"],
      ["auth_state_mismatch"],
      ["auth_provider_error"],
      ["generic"],
      ["something_else"],
      // A crafted link: a prototype member is a code like any other, and finds nothing.
      ["toString"],
      ["constructor"],
      ["__proto__"],
    ])("draws the card's title alone over Try again for %s", async (error) => {
      await renderWithTheme(<SignInScreen error={error} />);
      expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
      expect(drawn()).toEqual(BARE_REFUSAL);
      // Its label is the card's, for a screen reader to land on, and no code is ever said.
      expect(screen.getByLabelText(REFUSED)).toBeTruthy();
      const found = pressables(screen.toJSON() as HostNode);
      expect(found).toHaveLength(1);
      expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    });

    it.each([
      ["fi-FI", "Kirjaudu sisään", "Kirjautuminen ei onnistunut", "Yritä uudelleen"],
      ["sv-FI", "Logga in", "Inloggningen slutfördes inte", "Försök igen"],
    ])("says it in the language of a %s phone", async (languageTag, ...words) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
      try {
        await renderWithTheme(<SignInScreen error="auth_code_used" />);
        expect(await screen.findByRole("button", { name: words[2] })).toBeTruthy();
        expect(drawn()).toEqual(words);
      } finally {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
      }
    });
  });

  describe("the refusals that keep a line, cut to the fact (#581)", () => {
    it.each([
      ["auth_cancelled", "en-US", "Nothing was saved."],
      ["auth_cancelled", "fi-FI", "Mitään ei tallennettu."],
      ["auth_cancelled", "sv-FI", "Inget sparades."],
      ["unexpected_link", "en-US", NOT_REQUESTED],
      ["unexpected_link", "fi-FI", "Tätä kirjautumislinkkiä ei pyydetty tältä puhelimelta."],
      [
        "unexpected_link",
        "sv-FI",
        "Den här inloggningslänken begärdes inte från den här telefonen.",
      ],
      // The API refused the exchange for want of Apple's word on the app (ADR-069).
      ["attestation_refused", "en-US", "Apple could not confirm the app on this iPhone."],
      ["attestation_refused", "fi-FI", "Apple ei voinut varmistaa sovellusta tällä iPhonella."],
      ["attestation_refused", "sv-FI", "Apple kunde inte bekräfta appen på den här iPhonen."],
    ])("says %s on a %s phone in the one line, under the title", async (error, tag, line) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
      try {
        await renderWithTheme(<SignInScreen error={error} />);
        expect(await screen.findByText(line)).toBeTruthy();
        // The title, that line, and Try again: the second sentence was the button's.
        expect(drawn()).toHaveLength(4);
        expect(drawn()[2]).toBe(line);
      } finally {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
      }
    });
  });

  it("shows the cooldown with its date in the app's locale", async () => {
    await renderWithTheme(<SignInScreen error="auth_cooldown" until="2026-10-22T10:00:00.000Z" />);
    expect(await screen.findByText(/The earliest day for a new one: 22.10.2026/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  describe("the button under a refusal (#466)", () => {
    it.each([["auth_under_18"], ["auth_banned"], ["auth_suspended"], ["auth_cooldown"]])(
      "offers the sign-in, not another try, under %s, a refusal that lasts",
      async (error) => {
        await renderWithTheme(<SignInScreen error={error} />);
        const button = await screen.findByRole("button", { name: "Sign in with your bank" });
        // The label a screen reader says and the words on the button, each on its own.
        expect(button.props.accessibilityLabel).toBe("Sign in with your bank");
        expect(screen.getByText("Sign in with your bank")).toBeTruthy();
        expect(screen.queryByText("Try again")).toBeNull();
        const found = pressables(screen.toJSON() as HostNode);
        expect(found).toHaveLength(1);
        expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
      },
    );

    it.each([
      ["auth_code_used"],
      ["auth_state_mismatch"],
      ["auth_provider_error"],
      ["auth_cancelled"],
      ["auth_rate_limited"],
      ["rate_limited"],
      ["auth_unavailable"],
      ["unexpected_link"],
      ["attestation_refused"],
      ["something_else"],
      ["toString"],
    ])("keeps Try again under %s, a refusal that may pass", async (error) => {
      await renderWithTheme(<SignInScreen error={error} />);
      const button = await screen.findByRole("button", { name: "Try again" });
      expect(button.props.accessibilityLabel).toBe("Try again");
      expect(screen.getByText("Try again")).toBeTruthy();
      expect(screen.queryByText("Sign in with your bank")).toBeNull();
    });

    it("follows the refusal on the screen when the next one is of the other kind", async () => {
      const view = await renderWithTheme(<SignInScreen error="auth_cooldown" />);
      expect(await screen.findByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
      await view.rerender(underProviders(<SignInScreen error="auth_cancelled" />));
      expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Sign in with your bank" })).toBeNull();
      await view.rerender(underProviders(<SignInScreen error="auth_suspended" />));
      expect(await screen.findByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });

    it("keeps the bank one press away after a cooldown: the phone may be somebody else's", async () => {
      const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
      await renderWithTheme(
        <SignInScreen error="auth_cooldown" until="2026-10-22T10:00:00.000Z" />,
      );
      expect(await screen.findByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
      await pressStart(openURL);
      expect(lastStart(openURL).url).toBe(`${apiBaseUrl()}/auth/start?platform=ios&locale=en`);
      await waitFor(() => expect(drawn()).toEqual(READY));
    });

    it.each([
      ["fi-FI", "Kirjaudu pankkitunnuksilla", "Yritä uudelleen"],
      ["sv-FI", "Logga in med din bank", "Försök igen"],
    ])("says each button in the language of a %s phone", async (languageTag, signIn, tryAgain) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
      try {
        const view = await renderWithTheme(<SignInScreen error="auth_banned" />);
        expect(await screen.findByRole("button", { name: signIn })).toBeTruthy();
        await view.rerender(underProviders(<SignInScreen error="auth_cancelled" />));
        expect(await screen.findByRole("button", { name: tryAgain })).toBeTruthy();
      } finally {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
      }
    });
  });

  it("names the day a suspension ends, the start of that day in Finland", async () => {
    // Midnight in Finland in summer time (ADR-024 §5), as the API sends it.
    await renderWithTheme(<SignInScreen error="auth_suspended" until="2026-10-21T21:00:00.000Z" />);
    expect(
      await screen.findByText("This account is suspended. You can sign in again from: 22.10.2026"),
    ).toBeTruthy();
    expect(screen.queryByText("This account is suspended for now.")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
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
      // The web preview keeps nothing of this phone's store: no screens before a bank it cannot reach.
      expect(screen.queryByText(NORMS)).toBeNull();
    } finally {
      os.restore();
    }
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

  it("says the sign-in did not complete when the exchange fails without a word from the API", async () => {
    await markLoginStarted(VERIFIER);
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    await renderWithTheme(<SignInScreen code={CODE} />);
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    expect(drawn()).toEqual(BARE_REFUSAL);
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

  it("asks for the bank's chooser in Finnish in Stadi, which no bank speaks (#521)", async () => {
    store.set("kuutti.preference.locale", "fi-x-stadi");
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    try {
      await renderWithTheme(<SignInScreen />);
      await fireEvent.press(
        await screen.findByRole("button", { name: "Kirjaudu pankkitunnuksilla" }),
      );
      expect(lastStart(openURL).url).toBe(`${apiBaseUrl()}/auth/start?platform=ios&locale=fi`);
    } finally {
      store.delete("kuutti.preference.locale");
      openURL.mockRestore();
    }
  });

  it("says the sign-in did not complete when the browser cannot be opened, and offers to try again", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockRejectedValue(new Error("no browser"));
    try {
      await renderWithTheme(<SignInScreen />);
      await fireEvent.press(screen.getByRole("button", { name: "Sign in with your bank" }));
      expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
      expect(drawn()).toEqual(BARE_REFUSAL);
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

describe("SignInScreen: the screens before the bank (#418, ADR-010 §15)", () => {
  const consentsAnswer = () =>
    json({
      consents: [],
      currentVersions: {
        terms: TERMS,
        privacy: PRIVACY,
        research: RESEARCH,
        special_category: String(CONSENT_VERSIONS.special_category),
      },
    });
  type Call = { path: string; kind?: string; version?: string; locale?: string; auth?: string };
  /**
   * The API of a whole sign-in: the exchange as `exchange` answers, every
   * consent as `consent` answers its kind. Each call is kept in order, beside
   * the moment the screen goes home, with what it carried.
   */
  function serve(
    options: { exchange?: () => Response; consent?: (kind: string) => Response } = {},
  ) {
    const calls: Call[] = [];
    const order: string[] = [];
    fetchMock.mockImplementation(async (input) => {
      const request = input as Request;
      const path = new URL(request.url).pathname;
      if (path === "/auth/exchange") {
        calls.push({ path });
        order.push("exchange");
        return (options.exchange ?? (() => json(tokens)))();
      }
      const body = JSON.parse(await request.text()) as Call;
      calls.push({ ...body, path, auth: request.headers.get("authorization") ?? undefined });
      order.push(`consent ${body.kind}`);
      return (options.consent ?? consentsAnswer)(String(body.kind));
    });
    router.replace.mockImplementation((to: string) => order.push(`replace ${to}`));
    return { calls, order };
  }
  const posted = (calls: Call[]) => calls.filter((call) => call.path === "/consents");

  /** Through the screen before the bank. */
  async function agree() {
    await fireEvent.press(await screen.findByRole("button", { name: "I'm in, and I accept both" }));
    return screen.findByRole("button", { name: "Sign in with your bank" });
  }

  /** From the bank button to the deep link's code: the attempt this phone started. */
  async function throughTheBank(view: Awaited<ReturnType<typeof renderWithTheme>>, code = CODE) {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await pressStart(openURL);
    await view.rerender(underProviders(<SignInScreen code={code} />));
  }

  /** The phone's answer to whether it agreed before, held until `answer` gives it. */
  function holdTheRead() {
    const getItem = SecureStore.getItemAsync as jest.Mock;
    const original = getItem.getMockImplementation() as (key: string) => Promise<string | null>;
    let answer: (stored: string | null) => void = () => undefined;
    getItem.mockImplementation((key: string) =>
      key === AGREED
        ? new Promise<string | null>((resolve) => {
            answer = resolve;
          })
        : original(key),
    );
    return {
      answer: (stored: string | null) => act(async () => answer(stored)),
      restore: () => getItem.mockImplementation(original),
    };
  }

  it("The bank button is reached only after the terms and the privacy summary are accepted", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await renderWithTheme(<SignInScreen />);
    expect(await screen.findByRole("heading", { name: NORMS })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in with your bank" })).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: "I'm in, and I accept both" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(heldAgreements()).toEqual({ terms: TERMS, privacy: PRIVACY, locale: "en" });
    const found = pressables(screen.toJSON() as HostNode);
    expect(found).toHaveLength(1);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    await pressStart(openURL);
    expect(lastStart(openURL).url).toBe(`${apiBaseUrl()}/auth/start?platform=ios&locale=en`);
    // Nothing is sent before there is an account to bind it to.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Nothing is asked about research before the bank", async () => {
    const nothingOfResearch = () => {
      for (const words of [
        "Help us learn how matching works",
        "Research",
        "Yes, I take part",
        "Not now",
      ]) {
        expect(screen.queryByText(words)).toBeNull();
      }
    };
    await renderWithTheme(<SignInScreen />);
    expect(await screen.findByRole("heading", { name: NORMS })).toBeTruthy();
    nothingOfResearch();
    // One press and the bank button is there: no step on the way.
    await fireEvent.press(screen.getByRole("button", { name: "I'm in, and I accept both" }));
    expect(await screen.findByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
    nothingOfResearch();
    expect(heldAgreements()).not.toHaveProperty("research");
  });

  it("shows no button while the phone is asked whether it agreed before, then the screens before the bank", async () => {
    const read = holdTheRead();
    try {
      await renderWithTheme(<SignInScreen />);
      expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
      expect(drawn()).toEqual(["Sign in"]);
      expect(screen.queryByRole("button")).toBeNull();
      await read.answer(null);
      expect(await screen.findByRole("heading", { name: NORMS })).toBeTruthy();
    } finally {
      read.restore();
    }
  });

  it("shows the bank button once the phone answers that it agreed to the current wordings", async () => {
    const read = holdTheRead();
    try {
      await renderWithTheme(<SignInScreen />);
      expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
      await read.answer(JSON.stringify({ terms: TERMS, privacy: PRIVACY }));
      expect(await screen.findByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
      expect(screen.queryByText(NORMS)).toBeNull();
    } finally {
      read.restore();
    }
  });

  it("drops the phone's answer that arrives after the screen has gone", async () => {
    const read = holdTheRead();
    const error = jest.spyOn(console, "error");
    try {
      const view = await renderWithTheme(<SignInScreen />);
      expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
      await view.unmount();
      await read.answer(null);
      expect(error).not.toHaveBeenCalled();
    } finally {
      read.restore();
    }
  });

  it("A phone that recorded the current wordings goes straight to the bank", async () => {
    remember();
    const { calls, order } = serve();
    await markLoginStarted(VERIFIER);
    const view = await renderWithTheme(<SignInScreen />);
    expect(await screen.findByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
    expect(screen.queryByText(NORMS)).toBeNull();
    await throughTheBank(view);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    // The held answers are what becomes rows, not the phone's memory: none were given here.
    expect(order).toEqual(["exchange", "replace /"]);
    expect(posted(calls)).toEqual([]);
  });

  it("sees the screens before the bank again on a phone that recorded an older wording", async () => {
    store.set(AGREED, JSON.stringify({ terms: "2025-01-draft-1", privacy: PRIVACY }));
    await renderWithTheme(<SignInScreen />);
    expect(await screen.findByRole("heading", { name: NORMS })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with your bank" })).toBeNull();
  });

  it("goes straight to the bank with the answers held from this run, without asking the phone", async () => {
    holdAgreements({ terms: TERMS, privacy: PRIVACY, locale: "en" });
    await renderWithTheme(<SignInScreen />);
    expect(screen.getByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
    expect(
      (SecureStore.getItemAsync as jest.Mock).mock.calls.filter(([key]) => key === AGREED),
    ).toEqual([]);
  });

  it("The answers given before the bank become consent rows right after the exchange", async () => {
    const { calls, order } = serve();
    const view = await renderWithTheme(<SignInScreen />);
    await agree();
    await throughTheBank(view);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    // In order, all before the screen goes home: onboarding then finds them given.
    // Nothing about research, so a research consent the account already has stays.
    expect(order).toEqual(["exchange", "consent terms", "consent privacy", "replace /"]);
    // Bound to the account the exchange made, in the language the texts were shown in.
    expect(posted(calls)).toEqual(
      [
        ["terms", TERMS],
        ["privacy", PRIVACY],
      ].map(([kind, version]) => ({
        path: "/consents",
        kind,
        version,
        locale: "en",
        auth: `Bearer ${tokens.accessToken}`,
      })),
    );
    expect(currentSession()?.sessionId).toBe(tokens.sessionId);
    // This phone has them now, and the answers are spent.
    expect(JSON.parse(String(store.get(AGREED)))).toEqual({ terms: TERMS, privacy: PRIVACY });
    expect(heldAgreements()).toBeNull();
  });

  it("names the language the texts were shown in on a Finnish phone", async () => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: "fi-FI" }]);
    try {
      const { calls } = serve();
      const view = await renderWithTheme(<SignInScreen />);
      await fireEvent.press(
        await screen.findByRole("button", { name: "Olen mukana ja hyväksyn molemmat" }),
      );
      const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
      await fireEvent.press(
        await screen.findByRole("button", { name: "Kirjaudu pankkitunnuksilla" }),
      );
      await waitFor(() => expect(openURL).toHaveBeenCalledTimes(1));
      expect(lastStart(openURL).url).toBe(`${apiBaseUrl()}/auth/start?platform=ios&locale=fi`);
      await view.rerender(underProviders(<SignInScreen code={CODE} />));
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
      expect(posted(calls).map((call) => [call.kind, call.locale])).toEqual([
        ["terms", "fi"],
        ["privacy", "fi"],
      ]);
    } finally {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
    }
  });

  it.each([
    [
      "refused",
      () => json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
    ],
    [
      "unreachable",
      () => {
        throw new TypeError("Network request failed");
      },
    ],
  ])(
    "signs in and goes home when the consents are %s, leaving them to the welcome step",
    async (_how, failing) => {
      const { calls, order } = serve({ consent: failing });
      const view = await renderWithTheme(<SignInScreen />);
      await agree();
      await throughTheBank(view);
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
      // The terms did not land, so the privacy summary waits.
      expect(order).toEqual(["exchange", "consent terms", "replace /"]);
      expect(posted(calls)).toHaveLength(1);
      expect(currentSession()?.sessionId).toBe(tokens.sessionId);
      expect(screen.queryByText(REFUSED)).toBeNull();
      // Not remembered: the next sign-in on this phone asks again, as the welcome step does now.
      expect(store.has(AGREED)).toBe(false);
      expect(heldAgreements()).toBeNull();
    },
  );

  it("remembers the phone only when both the terms and the privacy summary landed", async () => {
    const { order } = serve({
      consent: (kind) =>
        kind === "privacy"
          ? json({ error: { code: "rate_limited", message: "x", requestId: "r" } }, 429)
          : consentsAnswer(),
    });
    const view = await renderWithTheme(<SignInScreen />);
    await agree();
    await throughTheBank(view);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(order).toEqual(["exchange", "consent terms", "consent privacy", "replace /"]);
    expect(store.has(AGREED)).toBe(false);
  });

  it("drops the answers at a refused exchange: Try again asks them again, and posts only the new ones", async () => {
    let exchanges = 0;
    const { calls, order } = serve({
      exchange: () => {
        exchanges += 1;
        return exchanges === 1
          ? json({ error: { code: "auth_code_used", message: "x", requestId: "r" } }, 401)
          : json(tokens);
      },
    });
    const view = await renderWithTheme(<SignInScreen />);
    await agree();
    await throughTheBank(view);
    expect(await screen.findByText(REFUSED)).toBeTruthy();
    expect(posted(calls)).toEqual([]);
    // Whoever tries again answers again: nobody inherits a refused attempt's answers.
    await fireEvent.press(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText(NORMS)).toBeTruthy();
    await agree();
    await throughTheBank(view, "d".repeat(43));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(order).toEqual([
      "exchange",
      "exchange",
      "consent terms",
      "consent privacy",
      "replace /",
    ]);
  });

  it("asks again when a second bank attempt starts on answers carried into the first", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await renderWithTheme(<SignInScreen />);
    await agree();
    await pressStart(openURL);
    // Back from a browser left without an answer; whoever taps now may be somebody else.
    await fireEvent.press(screen.getByRole("button", { name: "Sign in with your bank" }));
    expect(await screen.findByText(NORMS)).toBeTruthy();
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(heldAgreements()).toBeNull();
  });

  it("drops answers not yet carried to the bank when the app leaves the screen", async () => {
    const listeners: Array<(state: string) => void> = [];
    jest.spyOn(AppState, "addEventListener").mockImplementation((event, listener) => {
      if (event === "change") listeners.push(listener as (state: string) => void);
      return { remove: jest.fn() } as never;
    });
    await renderWithTheme(<SignInScreen />);
    await agree();
    await act(async () => {
      for (const listener of listeners) listener("inactive");
    });
    expect(screen.getByRole("button", { name: "Sign in with your bank" })).toBeTruthy();
    await act(async () => {
      for (const listener of listeners) listener("background");
    });
    expect(await screen.findByText(NORMS)).toBeTruthy();
    expect(heldAgreements()).toBeNull();
  });

  it("goes back to the screens before the bank when the answers grew stale before the bank was opened", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await renderWithTheme(<SignInScreen />);
    const now = Date.now();
    await agree();
    jest.spyOn(Date, "now").mockReturnValue(now + 11 * 60 * 1000);
    await fireEvent.press(screen.getByRole("button", { name: "Sign in with your bank" }));
    expect(await screen.findByText(NORMS)).toBeTruthy();
    expect(openURL).not.toHaveBeenCalled();
  });

  it("posts nothing for an exchange of another attempt than the one the answers went with", async () => {
    const { calls } = serve();
    const view = await renderWithTheme(<SignInScreen />);
    await agree();
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await pressStart(openURL);
    // Another attempt's mark, as if started elsewhere since: its code is exchanged, the answers are not its.
    await markLoginStarted("e".repeat(64));
    await view.rerender(underProviders(<SignInScreen code={CODE} />));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(posted(calls)).toEqual([]);
  });

  it("drops the answers when a refusal comes back through the link", async () => {
    const view = await renderWithTheme(<SignInScreen />);
    await agree();
    await view.rerender(underProviders(<SignInScreen error="auth_cancelled" />));
    expect(await screen.findByText("Sign-in did not complete")).toBeTruthy();
    await fireEvent.press(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText(NORMS)).toBeTruthy();
  });

  it.each([
    ["Try again", "auth_cancelled"],
    ["Sign in with your bank", "auth_cooldown"],
  ])(
    "leads a refusal's %s back to the screens before the bank on a phone that never answered them",
    async (name, error) => {
      const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
      await renderWithTheme(<SignInScreen error={error} />);
      expect(await screen.findByText("Sign-in did not complete")).toBeTruthy();
      const button = await screen.findByRole("button", { name });
      expect(pressables(screen.toJSON() as HostNode)).toHaveLength(1);
      await fireEvent.press(button);
      expect(await screen.findByRole("heading", { name: NORMS })).toBeTruthy();
      expect(openURL).not.toHaveBeenCalled();
      // Answered, the bank is one press away, with the refusal put behind.
      await agree();
      expect(screen.queryByText("Sign-in did not complete")).toBeNull();
      await pressStart(openURL);
    },
  );

  it("signs in a code that returns to a process which lost its answers, posting nothing", async () => {
    // Android may end the app while the browser is open: the answers went with it,
    // and onboarding's welcome step asks for the terms and the privacy summary instead.
    const { calls, order } = serve();
    await markLoginStarted(VERIFIER);
    await renderWithTheme(<SignInScreen code={CODE} />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(order).toEqual(["exchange", "replace /"]);
    expect(posted(calls)).toEqual([]);
    expect(screen.queryByText(NORMS)).toBeNull();
    expect(store.has(AGREED)).toBe(false);
  });
});
