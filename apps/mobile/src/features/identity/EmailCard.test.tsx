import { formatTime } from "@kuutti/i18n";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import type * as React from "react";
import { AccessibilityInfo, DeviceEventEmitter, Platform, StyleSheet, View } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import { EmailCard, EmailScreen } from "./EmailCard";
import { markLockOffered } from "./lock/LockProvider";

// The optional e-mail's card (#148) and its confirmation by a code (#385,
// ADR-043): every state the card shows, what each call answers in words, and
// the one code a new address gets by itself.

// NativeWind's colour-scheme setter needs its compiled stylesheet, which the
// test runner has none of: the web preview's theme effect calls it, seen, not applied.
jest.mock("nativewind", () => ({
  ...jest.requireActual("nativewind"),
  useColorScheme: () => ({ colorScheme: "light", setColorScheme: jest.fn() }),
}));

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock };
};
const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const auth = jest.requireMock("expo-local-authentication") as Record<
  | "hasHardwareAsync"
  | "isEnrolledAsync"
  | "supportedAuthenticationTypesAsync"
  | "authenticateAsync",
  jest.Mock
>;
const refusal = (code: string, status: number) =>
  new Response(JSON.stringify({ error: { code, message: "x", requestId: "r" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
const settle = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const show = (ui: React.ReactElement) =>
  act(async () => {
    renderWithTheme(ui);
    await settle();
  });
const press = (element: ReturnType<typeof screen.getByRole>) =>
  act(async () => {
    fireEvent.press(element);
    await settle();
  });
const type = (element: ReturnType<typeof screen.getByLabelText>, text: string) =>
  act(async () => {
    fireEvent.changeText(element, text);
    await settle();
  });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const button = (name: string) => screen.getByRole("button", { name });
const disabled = (name: string) => button(name).props.accessibilityState?.disabled;
const announced = () =>
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mock.calls.map(([words]) => words);
/** The card's notice: the assertive live region Android speaks as it appears. */
const liveRegion = () =>
  screen.container.queryAll(
    (node) => typeof node.type === "string" && node.props.accessibilityLiveRegion === "assertive",
  )[0];
/** What the notice says; null when the card says nothing. */
const spoken = () => liveRegion()?.children.join("") ?? null;
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);

/** Until when a code works, whatever the test machine's clock says: the card reads no clock. */
const LATER = "2099-06-01T12:34:00.000Z";
const RIGHT_CODE = "123456";

const TEXT = {
  unconfirmed: "An address is set, not confirmed yet.",
  confirmed: "An address is set and confirmed.",
  codeSent: (locale: "en" | "fi" = "en") =>
    locale === "fi"
      ? `Koodi on matkalla osoitteeseen. Se toimii kello ${formatTime("fi", new Date(LATER))} asti.`
      : `A code is on its way to the address. It works until ${formatTime("en", new Date(LATER))}.`,
  codeLabel: "The code from the message",
  confirm: "Confirm the address",
  send: "Send a code",
  sendAgain: "Send a new code",
  confirmedNow: "The address is confirmed.",
  codeWrong: "That is not the code. Check the message and try again.",
  codeFailed: "Something went wrong with the code. Try again.",
};

type Server = { email: string | null; confirmed: boolean; codeExpiresAt: string | null };

/**
 * A tiny server for the e-mail, as the API answers (ADR-043): read; set with
 * its validation, a different address unconfirmed and its waiting code gone;
 * cleared; a code sent; confirmed by RIGHT_CODE alone. `refuse` queues
 * answers that a route gives instead, one per call.
 */
function fakeApi(initial: Partial<Server> = {}) {
  const server: Server = { email: null, confirmed: false, codeExpiresAt: null, ...initial };
  const calls: string[] = [];
  const queued = new Map<string, (() => Response)[]>();
  const view = () => json({ ...server });
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const route = `${request.method} ${new URL(request.url).pathname}`;
    calls.push(route);
    const instead = queued.get(route)?.shift();
    if (instead) return instead();
    switch (route) {
      case "GET /account/email":
        return view();
      case "PUT /account/email": {
        const { email } = (await request.json()) as { email: string };
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return refusal("validation_failed", 400);
        if (email !== server.email) {
          Object.assign(server, { email, confirmed: false, codeExpiresAt: null });
        }
        return view();
      }
      case "DELETE /account/email":
        Object.assign(server, { email: null, confirmed: false, codeExpiresAt: null });
        return new Response(null, { status: 204 });
      case "POST /account/email/code":
        server.codeExpiresAt = LATER;
        return view();
      case "POST /account/email/confirm": {
        const { code } = (await request.json()) as { code: string };
        if (code !== RIGHT_CODE) return refusal("email_code_wrong", 400);
        Object.assign(server, { confirmed: true, codeExpiresAt: null });
        return view();
      }
      default:
        return refusal("not_found", 404);
    }
  }) as unknown as typeof fetch;
  const refuse = (route: string, ...answers: (() => Response)[]) => {
    queued.set(route, answers);
  };
  return { server, calls, refuse };
}

beforeEach(async () => {
  router.replace.mockReset();
  router.push.mockReset();
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
  // Nothing of the lock on this phone (#418): neither offered nor on.
  store.delete("kuutti.preference.lockOffered");
  store.delete("kuutti.lock");
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

afterEach(() => jest.restoreAllMocks());

describe("EmailCard, reading the address", () => {
  it("says it is reading the address while the read is on its way", async () => {
    globalThis.fetch = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    await show(<EmailCard />);
    expect(screen.getByText("Reading your e-mail address…")).toBeTruthy();
    expect(screen.getByText("Reading your e-mail address…").props.accessibilityLiveRegion).toBe(
      "polite",
    );
    expect(screen.queryByText("A way to stay in touch")).toBeNull();
  });

  it("says why the address could not be read, and reads it again on request (#287)", async () => {
    let failing = true;
    globalThis.fetch = jest.fn(async () =>
      failing
        ? refusal("internal_error", 500)
        : json({ email: null, confirmed: false, codeExpiresAt: null }),
    ) as unknown as typeof fetch;
    await show(<EmailCard />);
    expect(screen.getByText("Your e-mail address could not be read.")).toBeTruthy();
    expect(screen.queryByText("A way to stay in touch")).toBeNull();
    failing = false;
    await press(button("Try again"));
    expect(await screen.findByText("A way to stay in touch")).toBeTruthy();
  });

  it("shows nothing and asks nothing for a signed-out device", async () => {
    await clearSession();
    fakeApi();
    await show(<EmailCard />);
    expect(screen.queryByText("A way to stay in touch")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  describe("a read that comes back after the card is gone changes nothing", () => {
    it.each(["answered", "refused"] as const)("%s", async (outcome) => {
      let answer = (_: Response) => {};
      globalThis.fetch = jest.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ) as unknown as typeof fetch;
      const view = await renderWithTheme(<EmailCard />);
      await view.rerender(underProviders(<View />));
      await act(async () => {
        answer(
          outcome === "answered"
            ? json({ email: null, confirmed: false, codeExpiresAt: null })
            : refusal("internal_error", 500),
        );
        await settle();
      });
      expect(screen.queryByText("A way to stay in touch")).toBeNull();
      expect(screen.queryByText("Your e-mail address could not be read.")).toBeNull();
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });

  it("with no address, offers the field and Save, and says nothing of a code", async () => {
    fakeApi();
    await show(<EmailCard />);
    expect(screen.getByText("A way to stay in touch")).toBeTruthy();
    expect(screen.getByText(/never a login/)).toBeTruthy();
    expect(disabled("Send a confirmation code")).toBe(true);
    for (const text of [TEXT.unconfirmed, TEXT.confirmed, TEXT.send, TEXT.codeLabel]) {
      expect(screen.queryByText(text)).toBeNull();
    }
    expect(screen.queryByRole("button", { name: "Remove the address" })).toBeNull();
    noProblems();
  });

  it("with a confirmed address, says so and offers no code, nor saving the same address", async () => {
    fakeApi({ email: "aino@example.fi", confirmed: true });
    await show(<EmailCard />);
    expect(screen.getByText(TEXT.confirmed)).toBeTruthy();
    expect(screen.getByLabelText("E-mail address").props.value).toBe("aino@example.fi");
    expect(disabled("Send a confirmation code")).toBe(true);
    for (const name of [TEXT.confirm, TEXT.send, TEXT.sendAgain]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByLabelText(TEXT.codeLabel)).toBeNull();
    noProblems();
  });

  it("with an unconfirmed address and no code waiting, offers to send one and sends nothing by itself", async () => {
    const { calls } = fakeApi({ email: "aino@example.fi" });
    await show(<EmailCard />);
    expect(screen.getByText(TEXT.unconfirmed)).toBeTruthy();
    expect(button(TEXT.send)).toBeTruthy();
    expect(screen.queryByLabelText(TEXT.codeLabel)).toBeNull();
    expect(calls).toEqual(["GET /account/email"]);
    noProblems();
  });

  it("with a code waiting, says until when, and offers the code's field, Confirm and a new code", async () => {
    fakeApi({ email: "aino@example.fi", codeExpiresAt: LATER });
    await show(<EmailCard />);
    expect(screen.getByText(TEXT.unconfirmed)).toBeTruthy();
    expect(screen.getByText(TEXT.codeSent())).toBeTruthy();
    // Read, not sent: the card says nothing until a call answers.
    expect(spoken()).toBeNull();
    expect(screen.getByText(TEXT.codeLabel)).toBeTruthy();
    expect(disabled(TEXT.confirm)).toBe(true);
    expect(disabled(TEXT.sendAgain)).toBe(false);
    expect(screen.queryByRole("button", { name: TEXT.send })).toBeNull();
    noProblems();
  });

  it("says until when the code works in the person's language, as hours and minutes", async () => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: "fi-FI" }]);
    fakeApi({ email: "aino@example.fi", codeExpiresAt: LATER });
    await show(<EmailCard />);
    expect(screen.getByText(TEXT.codeSent("fi"))).toBeTruthy();
    expect(screen.getByText(/kello \d{2}\.\d{2} asti/)).toBeTruthy();
    expect(screen.getByLabelText("Viestin koodi")).toBeTruthy();
    expect(button("Vahvista osoite")).toBeTruthy();
  });
});

describe("EmailCard, the code", () => {
  it("names the code's field for the screen reader and asks the phone for digits and a one-time code", async () => {
    fakeApi({ email: "aino@example.fi", codeExpiresAt: LATER });
    await show(<EmailCard />);
    const field = screen.getByLabelText(TEXT.codeLabel);
    expect(field.props).toMatchObject({
      accessibilityLabel: TEXT.codeLabel,
      inputMode: "numeric",
      textContentType: "oneTimeCode",
      autoComplete: "one-time-code",
      maxLength: 6,
    });
  });

  it("takes digits only, enables Confirm at six, and confirms the address: no code asked after", async () => {
    const { server, calls } = fakeApi({ email: "aino@example.fi", codeExpiresAt: LATER });
    await show(<EmailCard />);
    await type(screen.getByLabelText(TEXT.codeLabel), "12 3a45");
    expect(screen.getByLabelText(TEXT.codeLabel).props.value).toBe("12345");
    expect(disabled(TEXT.confirm)).toBe(true);
    await type(screen.getByLabelText(TEXT.codeLabel), "1234567");
    expect(screen.getByLabelText(TEXT.codeLabel).props.value).toBe(RIGHT_CODE);
    expect(disabled(TEXT.confirm)).toBe(false);
    await press(button(TEXT.confirm));
    expect(screen.getByText(TEXT.confirmedNow).props.accessibilityLiveRegion).toBe("assertive");
    expect(screen.getByText(TEXT.confirmed)).toBeTruthy();
    expect(screen.queryByText(TEXT.unconfirmed)).toBeNull();
    expect(screen.queryByLabelText(TEXT.codeLabel)).toBeNull();
    expect(screen.queryByRole("button", { name: TEXT.sendAgain })).toBeNull();
    expect(server.confirmed).toBe(true);
    expect(calls).toEqual(["GET /account/email", "POST /account/email/confirm"]);
  });

  it("says a wrong code is wrong, empties the field and keeps the code waiting; typing again clears the line", async () => {
    fakeApi({ email: "aino@example.fi", codeExpiresAt: LATER });
    await show(<EmailCard />);
    await type(screen.getByLabelText(TEXT.codeLabel), "000000");
    await press(button(TEXT.confirm));
    expect(screen.getByText(TEXT.codeWrong).props.accessibilityLiveRegion).toBe("assertive");
    expect(screen.getByLabelText(TEXT.codeLabel).props.value).toBe("");
    expect(disabled(TEXT.confirm)).toBe(true);
    expect(screen.getByText(TEXT.codeSent())).toBeTruthy();
    await type(screen.getByLabelText(TEXT.codeLabel), "1");
    expect(screen.queryByText(TEXT.codeWrong)).toBeNull();
  });

  describe("a refusal that leaves no code waiting says why, and offers a new one", () => {
    it.each([
      ["email_code_spent", "Too many wrong codes. Send a new one."],
      ["email_code_expired", "That code has expired. Send a new one."],
      ["email_code_none", "No code is waiting. Send a new one."],
    ])("%s", async (code, words) => {
      const { refuse, calls } = fakeApi({ email: "aino@example.fi", codeExpiresAt: LATER });
      refuse("POST /account/email/confirm", () => refusal(code, 409));
      await show(<EmailCard />);
      await type(screen.getByLabelText(TEXT.codeLabel), "000000");
      await press(button(TEXT.confirm));
      expect(screen.getByText(words)).toBeTruthy();
      expect(screen.queryByLabelText(TEXT.codeLabel)).toBeNull();
      expect(screen.queryByText(/A code is on its way/)).toBeNull();
      await press(button(TEXT.send));
      expect(screen.queryByText(words)).toBeNull();
      expect(spoken()).toBe(TEXT.codeSent());
      expect(screen.getByLabelText(TEXT.codeLabel).props.value).toBe("");
      expect(calls.at(-1)).toBe("POST /account/email/code");
    });
  });

  it("a code that runs out while the card is open keeps its field and Confirm until Confirm's answer says it expired", async () => {
    // Before the session's own expiry, so no call is held for a refresh.
    const SOON = "2029-06-01T12:34:00.000Z";
    const clock = jest.spyOn(Date, "now").mockReturnValue(Date.parse(SOON) - 60_000);
    const { refuse } = fakeApi({ email: "aino@example.fi", codeExpiresAt: SOON });
    await show(<EmailCard />);
    clock.mockReturnValue(Date.parse(SOON) + 60_000);
    await type(screen.getByLabelText(TEXT.codeLabel), "1");
    expect(screen.getByLabelText(TEXT.codeLabel).props.value).toBe("1");
    expect(button(TEXT.confirm)).toBeTruthy();
    expect(screen.queryByRole("button", { name: TEXT.send })).toBeNull();
    refuse("POST /account/email/confirm", () => refusal("email_code_expired", 409));
    await type(screen.getByLabelText(TEXT.codeLabel), RIGHT_CODE);
    await press(button(TEXT.confirm));
    expect(spoken()).toBe("That code has expired. Send a new one.");
    expect(screen.queryByLabelText(TEXT.codeLabel)).toBeNull();
    expect(button(TEXT.send)).toBeTruthy();
  });

  describe("a new code refused says why and leaves the waiting one as it was", () => {
    it.each([
      [
        "email_code_budget_exceeded",
        429,
        "That is enough codes for today. You can send a new one after midnight.",
      ],
      ["mail_unavailable", 503, "The code could not be sent just now. Try again later."],
      ["internal_error", 500, TEXT.codeFailed],
    ])("%s", async (code, status, words) => {
      const { refuse } = fakeApi({ email: "aino@example.fi", codeExpiresAt: LATER });
      refuse("POST /account/email/code", () => refusal(code, status));
      await show(<EmailCard />);
      await type(screen.getByLabelText(TEXT.codeLabel), "123");
      await press(button(TEXT.sendAgain));
      expect(screen.getByText(words).props.accessibilityLiveRegion).toBe("assertive");
      expect(screen.getByText(TEXT.codeSent())).toBeTruthy();
      expect(screen.getByLabelText(TEXT.codeLabel).props.value).toBe("123");
    });
  });

  it("a confirmation the API answers with no envelope says the code failed", async () => {
    const { refuse } = fakeApi({ email: "aino@example.fi", codeExpiresAt: LATER });
    refuse("POST /account/email/confirm", () => new Response("oops", { status: 502 }));
    await show(<EmailCard />);
    await type(screen.getByLabelText(TEXT.codeLabel), RIGHT_CODE);
    await press(button(TEXT.confirm));
    expect(screen.getByText(TEXT.codeFailed)).toBeTruthy();
    expect(screen.getByText(TEXT.unconfirmed)).toBeTruthy();
  });

  it("a send that never reaches the API says the code failed", async () => {
    const { refuse } = fakeApi({ email: "aino@example.fi" });
    refuse("POST /account/email/code", () => {
      throw new TypeError("Network request failed");
    });
    await show(<EmailCard />);
    await press(button(TEXT.send));
    expect(screen.getByText(TEXT.codeFailed)).toBeTruthy();
    expect(button(TEXT.send)).toBeTruthy();
  });

  it("says each notice aloud on iOS, which has no live regions, a repeated one again", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    fakeApi({ email: "aino@example.fi", codeExpiresAt: LATER });
    await show(<EmailCard />);
    for (const _ of [1, 2]) {
      await type(screen.getByLabelText(TEXT.codeLabel), "000000");
      await press(button(TEXT.confirm));
    }
    await type(screen.getByLabelText(TEXT.codeLabel), RIGHT_CODE);
    await press(button(TEXT.confirm));
    expect(announced()).toEqual([TEXT.codeWrong, TEXT.codeWrong, TEXT.confirmedNow]);
  });

  it("leaves the saying to the live region on Android", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    fakeApi({ email: "aino@example.fi", codeExpiresAt: LATER });
    await show(<EmailCard />);
    await type(screen.getByLabelText(TEXT.codeLabel), "000000");
    await press(button(TEXT.confirm));
    expect(screen.getByText(TEXT.codeWrong).props.accessibilityLiveRegion).toBe("assertive");
    expect(announced()).toEqual([]);
  });

  /** Send a code, Send a new code twice within the minute, and a save that sends one: `heard` after each. */
  const sendEachWay = async (heard: () => void) => {
    fakeApi({ email: "aino@example.fi" });
    await show(<EmailCard />);
    await press(button(TEXT.send));
    heard();
    for (const _ of [1, 2]) {
      await press(button(TEXT.sendAgain));
      heard();
    }
    await type(screen.getByLabelText("E-mail address"), "aino@example.org");
    await press(button("Send a confirmation code"));
    heard();
  };

  it("says aloud on iOS until when each code sent works, the same words again for a second code within the minute", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    await sendEachWay(() => undefined);
    expect(announced()).toEqual([
      TEXT.codeSent(),
      TEXT.codeSent(),
      TEXT.codeSent(),
      `Saved. ${TEXT.codeSent()}`,
    ]);
  });

  it("carries until when each code sent works in the live region on Android, a fresh one for each code", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const regions: unknown[] = [];
    const words: (string | null)[] = [];
    await sendEachWay(() => {
      regions.push(liveRegion());
      words.push(spoken());
    });
    expect(words).toEqual([
      TEXT.codeSent(),
      TEXT.codeSent(),
      TEXT.codeSent(),
      `Saved. ${TEXT.codeSent()}`,
    ]);
    // Each answer a new region, which Android speaks as it appears: the same words too.
    expect(new Set(regions).size).toBe(regions.length);
    expect(announced()).toEqual([]);
  });

  it("a new code sent replaces the digits typed for the old one", async () => {
    const { calls } = fakeApi({ email: "aino@example.fi", codeExpiresAt: LATER });
    await show(<EmailCard />);
    await type(screen.getByLabelText(TEXT.codeLabel), "123");
    await press(button(TEXT.sendAgain));
    expect(screen.getByLabelText(TEXT.codeLabel).props.value).toBe("");
    expect(calls).toEqual(["GET /account/email", "POST /account/email/code"]);
  });

  it("a send answered confirmed already reads the address again and shows it confirmed", async () => {
    const { server, refuse, calls } = fakeApi({ email: "aino@example.fi" });
    refuse("POST /account/email/code", () => {
      // Confirmed on another phone meanwhile.
      server.confirmed = true;
      return refusal("email_confirmed", 409);
    });
    await show(<EmailCard />);
    await press(button(TEXT.send));
    expect(screen.getByText(TEXT.confirmedNow)).toBeTruthy();
    expect(screen.getByText(TEXT.confirmed)).toBeTruthy();
    expect(screen.queryByRole("button", { name: TEXT.send })).toBeNull();
    expect(calls).toEqual(["GET /account/email", "POST /account/email/code", "GET /account/email"]);
  });

  it("a send answered confirmed, read again as unconfirmed after all, shows what the read found without a word", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const { refuse } = fakeApi({ email: "aino@example.fi" });
    refuse("POST /account/email/code", () => refusal("email_confirmed", 409));
    await show(<EmailCard />);
    await press(button(TEXT.send));
    expect(screen.getByText(TEXT.unconfirmed)).toBeTruthy();
    expect(spoken()).toBeNull();
    expect(announced()).toEqual([]);
    expect(button(TEXT.send)).toBeTruthy();
  });

  describe("a refusal that says the address was removed on another phone reads it again and shows the card without it", () => {
    it.each([
      [TEXT.sendAgain, "POST /account/email/code"],
      [TEXT.confirm, "POST /account/email/confirm"],
    ])("%s", async (name, route) => {
      const { server, refuse, calls } = fakeApi({ email: "aino@example.fi", codeExpiresAt: LATER });
      refuse(route, () => {
        Object.assign(server, { email: null, confirmed: false, codeExpiresAt: null });
        return refusal("email_none", 409);
      });
      await show(<EmailCard />);
      await type(screen.getByLabelText(TEXT.codeLabel), RIGHT_CODE);
      await press(button(name));
      expect(screen.getByLabelText("E-mail address").props.value).toBe("");
      for (const text of [TEXT.unconfirmed, TEXT.codeSent(), TEXT.codeLabel]) {
        expect(screen.queryByText(text)).toBeNull();
      }
      for (const other of [TEXT.send, TEXT.confirm, "Remove the address"]) {
        expect(screen.queryByRole("button", { name: other })).toBeNull();
      }
      expect(spoken()).toBeNull();
      expect(calls).toEqual(["GET /account/email", route, "GET /account/email"]);
    });
  });

  describe("a send answered with the address another phone changed it to", () => {
    const changedElsewhere = () => {
      const { server, refuse } = fakeApi({ email: "aino@example.fi" });
      refuse("POST /account/email/code", () => {
        Object.assign(server, { email: "aino@example.org", codeExpiresAt: LATER });
        return json({ ...server });
      });
    };

    it("shows that address in the field the person had not typed in", async () => {
      changedElsewhere();
      await show(<EmailCard />);
      await press(button(TEXT.send));
      expect(screen.getByLabelText("E-mail address").props.value).toBe("aino@example.org");
      expect(disabled("Send a confirmation code")).toBe(true);
      expect(spoken()).toBe(TEXT.codeSent());
    });

    it("keeps what the person typed in the field", async () => {
      changedElsewhere();
      await show(<EmailCard />);
      await type(screen.getByLabelText("E-mail address"), "aino@example.net");
      await press(button(TEXT.send));
      expect(screen.getByLabelText("E-mail address").props.value).toBe("aino@example.net");
      expect(disabled("Send a confirmation code")).toBe(false);
      expect(screen.getByText(TEXT.unconfirmed)).toBeTruthy();
    });
  });

  it("a send answered confirmed whose read fails says the code failed", async () => {
    const { refuse } = fakeApi({ email: "aino@example.fi" });
    refuse("POST /account/email/code", () => refusal("email_confirmed", 409));
    refuse(
      "GET /account/email",
      () => json({ email: "aino@example.fi", confirmed: false, codeExpiresAt: null }),
      () => refusal("internal_error", 500),
    );
    await show(<EmailCard />);
    await press(button(TEXT.send));
    expect(screen.getByText(TEXT.codeFailed)).toBeTruthy();
    expect(screen.getByText(TEXT.unconfirmed)).toBeTruthy();
  });

  it("while a call is on its way, every button waits for it", async () => {
    fakeApi({ email: "aino@example.fi", codeExpiresAt: LATER });
    const answer = globalThis.fetch;
    // The confirmation never comes back.
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return request.method === "POST" ? new Promise<Response>(() => {}) : answer(input, init);
    }) as unknown as typeof fetch;
    await show(<EmailCard />);
    await type(screen.getByLabelText(TEXT.codeLabel), RIGHT_CODE);
    await press(button(TEXT.confirm));
    for (const name of [TEXT.confirm, TEXT.sendAgain, "Remove the address"]) {
      expect(disabled(name)).toBe(true);
    }
  });
});

describe("EmailCard, saving and removing", () => {
  it("saves an address, says it is not confirmed, and sends its code by itself, once", async () => {
    const { server, calls } = fakeApi();
    await show(<EmailCard />);
    await type(screen.getByLabelText("E-mail address"), "  aino@example.fi ");
    noProblems();
    await press(button("Send a confirmation code"));
    expect(spoken()).toBe(`Saved. ${TEXT.codeSent()}`);
    expect(screen.getByText(TEXT.unconfirmed)).toBeTruthy();
    expect(screen.getByText(TEXT.codeSent())).toBeTruthy();
    expect(screen.getByLabelText("E-mail address").props.value).toBe("aino@example.fi");
    expect(server).toEqual({ email: "aino@example.fi", confirmed: false, codeExpiresAt: LATER });
    expect(calls).toEqual(["GET /account/email", "PUT /account/email", "POST /account/email/code"]);
    noProblems();
  });

  it("changing a confirmed address unconfirms it and sends the new one its code", async () => {
    const { server, calls } = fakeApi({ email: "aino@example.fi", confirmed: true });
    await show(<EmailCard />);
    await type(screen.getByLabelText("E-mail address"), "aino@example.org");
    await press(button("Send a confirmation code"));
    expect(screen.getByText(TEXT.unconfirmed)).toBeTruthy();
    expect(screen.getByText(TEXT.codeSent())).toBeTruthy();
    expect(server.email).toBe("aino@example.org");
    expect(calls).toEqual(["GET /account/email", "PUT /account/email", "POST /account/email/code"]);
  });

  it("a save the API answers with a code still waiting sends none", async () => {
    const { refuse, calls } = fakeApi({ email: "aino@example.fi", codeExpiresAt: LATER });
    // The same address in other letters, which the API takes for the same one.
    refuse("PUT /account/email", () =>
      json({ email: "aino@example.fi", confirmed: false, codeExpiresAt: LATER }),
    );
    await show(<EmailCard />);
    await type(screen.getByLabelText("E-mail address"), "Aino@example.fi");
    await press(button("Send a confirmation code"));
    expect(spoken()).toBe("Saved.");
    expect(calls).toEqual(["GET /account/email", "PUT /account/email"]);
  });

  it("a save the API answers confirmed sends no code and offers none", async () => {
    const { refuse, calls } = fakeApi({ email: "aino@example.fi", confirmed: true });
    // The same address in other letters: still the confirmed one.
    refuse("PUT /account/email", () =>
      json({ email: "aino@example.fi", confirmed: true, codeExpiresAt: null }),
    );
    await show(<EmailCard />);
    await type(screen.getByLabelText("E-mail address"), "Aino@example.fi");
    await press(button("Send a confirmation code"));
    expect(spoken()).toBe("Saved.");
    expect(screen.getByText(TEXT.confirmed)).toBeTruthy();
    expect(screen.queryByLabelText(TEXT.codeLabel)).toBeNull();
    for (const name of [TEXT.send, TEXT.sendAgain, TEXT.confirm]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(calls).toEqual(["GET /account/email", "PUT /account/email"]);
  });

  it("a save whose own send fails keeps the address and says why the code did not go", async () => {
    const { server, refuse } = fakeApi();
    refuse("POST /account/email/code", () => refusal("mail_unavailable", 503));
    await show(<EmailCard />);
    await type(screen.getByLabelText("E-mail address"), "aino@example.fi");
    await press(button("Send a confirmation code"));
    expect(spoken()).toBe("Saved. The code could not be sent just now. Try again later.");
    expect(screen.getByText(TEXT.unconfirmed)).toBeTruthy();
    expect(button(TEXT.send)).toBeTruthy();
    expect(server.email).toBe("aino@example.fi");
    await press(button(TEXT.send));
    expect(spoken()).toBe(TEXT.codeSent());
  });

  it("says when the API refuses an address, and saves nothing", async () => {
    const { server, calls } = fakeApi();
    await show(<EmailCard />);
    await type(screen.getByLabelText("E-mail address"), "aino");
    await press(button("Send a confirmation code"));
    expect(screen.getByText("That does not look like an e-mail address.")).toBeTruthy();
    expect(screen.queryByText(TEXT.unconfirmed)).toBeNull();
    expect(server.email).toBeNull();
    expect(calls).toEqual(["GET /account/email", "PUT /account/email"]);
  });

  it("says the address could not be saved when the API fails, as opposed to refusing it", async () => {
    const { refuse } = fakeApi();
    refuse("PUT /account/email", () => refusal("internal_error", 500));
    await show(<EmailCard />);
    await type(screen.getByLabelText("E-mail address"), "aino@example.fi");
    await press(button("Send a confirmation code"));
    expect(screen.getByText("The address could not be saved. Try again.")).toBeTruthy();
    expect(screen.queryByText("That does not look like an e-mail address.")).toBeNull();
    // Typing again clears the line.
    await type(screen.getByLabelText("E-mail address"), "aino@example.org");
    expect(screen.queryByText("The address could not be saved. Try again.")).toBeNull();
  });

  it("removing clears everything: the address, its line, the code and its field", async () => {
    const { server, calls } = fakeApi({ email: "aino@example.fi", codeExpiresAt: LATER });
    await show(<EmailCard />);
    await type(screen.getByLabelText(TEXT.codeLabel), "123");
    await press(button("Remove the address"));
    expect(screen.getByText("Saved.")).toBeTruthy();
    expect(screen.getByLabelText("E-mail address").props.value).toBe("");
    for (const text of [TEXT.unconfirmed, TEXT.codeSent(), TEXT.codeLabel]) {
      expect(screen.queryByText(text)).toBeNull();
    }
    expect(screen.queryByRole("button", { name: TEXT.sendAgain })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove the address" })).toBeNull();
    expect(server.email).toBeNull();
    expect(calls).toEqual(["GET /account/email", "DELETE /account/email"]);
  });

  it("says the address could not be removed when the API fails, and keeps it", async () => {
    const { refuse } = fakeApi({ email: "aino@example.fi", confirmed: true });
    refuse("DELETE /account/email", () => refusal("internal_error", 500));
    await show(<EmailCard />);
    await press(button("Remove the address"));
    expect(screen.getByText("The address could not be saved. Try again.")).toBeTruthy();
    expect(screen.getByText(TEXT.confirmed)).toBeTruthy();
  });
});

describe("EmailScreen", () => {
  it("leads on to the lock's one offer while it is due (#418)", async () => {
    fakeApi({ email: "aino@example.fi", confirmed: true });
    await show(<EmailScreen />);
    await waitFor(() => expect(screen.getByText(TEXT.confirmed)).toBeTruthy());
    expect(screen.getByText("That is everything. Thank you.")).toBeTruthy();
    await press(button("Done"));
    expect(router.replace).toHaveBeenCalledWith("/account/lock");
    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  it("The lock is offered once after the e-mail", async () => {
    fakeApi();
    await show(<EmailScreen />);
    await press(button("Done"));
    expect(router.replace).toHaveBeenLastCalledWith("/account/lock");
    // The offer's screen marks it offered as it shows (LockOfferScreen).
    await act(() => markLockOffered());
    expect(store.get("kuutti.preference.lockOffered")).toBe("true");
    await show(<EmailScreen />);
    await press(button("Done"));
    expect(router.replace).toHaveBeenLastCalledWith("/");
    expect(router.replace).toHaveBeenCalledTimes(2);
  });

  describe("leads home without the offer", () => {
    afterEach(() => {
      // Back to the phone of jest.setup.js: neither face nor fingerprint.
      auth.hasHardwareAsync.mockResolvedValue(false);
      auth.isEnrolledAsync.mockResolvedValue(false);
      auth.supportedAuthenticationTypesAsync.mockResolvedValue([]);
      auth.authenticateAsync.mockResolvedValue({ success: false, error: "not_available" });
    });

    it("while the lock is on already", async () => {
      // A lock the face opens as the app starts, as one set in Settings before the offer.
      auth.hasHardwareAsync.mockResolvedValue(true);
      auth.isEnrolledAsync.mockResolvedValue(true);
      auth.supportedAuthenticationTypesAsync.mockResolvedValue([2]);
      auth.authenticateAsync.mockResolvedValue({ success: true });
      store.set(
        "kuutti.lock",
        JSON.stringify({ biometrics: true, passcode: null, graceMinutes: 1 }),
      );
      fakeApi();
      await show(<EmailScreen />);
      expect(screen.queryByText("Kuutti is locked")).toBeNull();
      await press(button("Done"));
      expect(router.replace).toHaveBeenCalledWith("/");
      expect(store.has("kuutti.preference.lockOffered")).toBe(false);
    });

    it("on the web preview, which has no lock", async () => {
      jest.replaceProperty(Platform, "OS", "web");
      fakeApi();
      await show(<EmailScreen />);
      await press(button("Done"));
      expect(router.replace).toHaveBeenCalledWith("/");
    });
  });

  it("as the last of the later screens, scrolls, so at the largest text every line is in reach (#217)", async () => {
    fakeApi({ email: "aino@example.fi", codeExpiresAt: LATER });
    await show(<EmailScreen />);
    await waitFor(() => expect(screen.getByText(TEXT.unconfirmed)).toBeTruthy());
    /** Whether the element lies inside the screen's scroll view, which a finger can move. */
    const scrolls = (element: { type: unknown; parent: unknown }): boolean => {
      for (let node: unknown = element.parent; node; node = (node as { parent: unknown }).parent) {
        if ((node as { type: unknown }).type === "RCTScrollView") return true;
      }
      return false;
    };
    for (const element of [
      screen.getByText("While you wait"),
      screen.getByText("A way to stay in touch"),
      screen.getByLabelText("E-mail address"),
      screen.getByText(TEXT.codeSent()),
      screen.getByLabelText(TEXT.codeLabel),
      button(TEXT.confirm),
      button(TEXT.sendAgain),
      button("Remove the address"),
      screen.getByText("That is everything. Thank you."),
      button("Your deal-breakers"),
      button("Done"),
    ]) {
      expect(scrolls(element)).toBe(true);
    }
    noProblems();
  });

  describe("keeps the code's field and Confirm above the keyboard, as a settings screen does (#103)", () => {
    // The screen's scroll view, and the view around it that gives way to the keyboard.
    const page = () => {
      const scroll = screen.container.queryAll((node) => node.type === "RCTScrollView")[0];
      let around = scroll?.parent ?? null;
      while (around && typeof around.type !== "string") around = around.parent;
      if (!scroll || !around) throw new Error("no scroll view on the screen");
      return { scroll, around, padding: StyleSheet.flatten(around.props.style).paddingBottom };
    };
    // The screen from y 100 to 800; the keyboard's top at 500.
    const keyboard = (event: string) =>
      act(async () => {
        DeviceEventEmitter.emit(event, {
          endCoordinates: { screenX: 0, screenY: 500, width: 400, height: 300 },
        });
      });
    const open = async () => {
      fakeApi({ email: "aino@example.fi", codeExpiresAt: LATER });
      await show(<EmailScreen />);
      expect(screen.getByLabelText(TEXT.codeLabel)).toBeTruthy();
      // The view reads its place from the layout event, which it keeps (persist).
      await act(async () => {
        fireEvent(page().around, "layout", {
          persist: () => undefined,
          nativeEvent: { layout: { x: 0, y: 100, width: 400, height: 700 } },
        });
      });
    };

    it("on Android, by ending the scroll view at the keyboard's top, and no longer once it goes", async () => {
      jest.replaceProperty(Platform, "OS", "android");
      await open();
      expect(page().padding).toBe(0);
      await keyboard("keyboardDidShow");
      expect(page().padding).toBe(300);
      await keyboard("keyboardDidHide");
      expect(page().padding).toBe(0);
    });

    it("on iOS, by the scroll view's own inset, without the padding too", async () => {
      jest.replaceProperty(Platform, "OS", "ios");
      await open();
      expect(page().scroll.props.automaticallyAdjustKeyboardInsets).toBe(true);
      await keyboard("keyboardWillShow");
      expect(page().padding).toBe(0);
      await keyboard("keyboardWillHide");
    });
  });

  it("as the last of the later screens, offers the deal-breakers on the way", async () => {
    fakeApi();
    await show(<EmailScreen />);
    await press(button("Your deal-breakers"));
    expect(router.push).toHaveBeenCalledWith("/profile/deal-breakers");
  });
});
