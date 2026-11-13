import type { ContactKind } from "@kuutti/schema";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { AccessibilityInfo, Platform } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { UnsavedRow } from "@/lib/unsaved";
import { type HostNode, markBefore, noProblems, pressables } from "@/test/a11y";
import { FAILED_TO_LOAD } from "@/test/failed";
import { renderWithTheme, underProviders } from "@/test/render";
import { YourContacts } from "./YourContacts";

// The contacts a person keeps (#103), under Settings' Ways to reach you row
// (#511): the read with its loading line and its failure, a part per kind
// with its field as the kind wants it, a number's country code beside its
// field, no Save (leaving the field keeps it), the phone's own check before
// the API's, the stored form shown back, Remove only while one is kept, each
// outcome said in words, a removal said and not drawn (#581), and no value in
// a pressable's label.

const INTRO =
  "Nobody sees them until you share one in a conversation. A change or a removal shows at once wherever you shared it.";
const PHONE_HINT = "For another country's number, choose its code first.";
const REMOVED = "Removed. Wherever you shared it, it is gone now.";
/** Every text on the screen, in order. */
const drawn = () => screen.queryAllByText(/./).map((node) => node.props.children);
/** What a screen reader was told, by the call: `queued` is iOS's, `plain` Android's (sayAloud). */
const told = () => ({
  queued: (AccessibilityInfo.announceForAccessibilityWithOptions as jest.Mock).mock.calls.map(
    ([words]) => words,
  ),
  plain: (AccessibilityInfo.announceForAccessibility as jest.Mock).mock.calls.map(
    ([words]) => words,
  ),
});
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const AT = "2026-10-18T09:00:00.000Z";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

type Call = { method: string; path: string; body: unknown };
/**
 * The contacts' routes as the API answers them: the stored pieces, a save in
 * the stored form, a removal; `answers` answer the next requests instead, an
 * Error failing the request.
 */
function contactsApi(
  stored: Partial<Record<ContactKind, string>> = {},
  answers: Array<Response | Error> = [],
) {
  const server = { ...stored };
  const calls: Call[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    const text = request.method === "GET" ? "" : await request.text();
    calls.push({ method: request.method, path, body: text ? JSON.parse(text) : null });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    const kind = path.split("/")[2] as ContactKind;
    if (request.method === "GET") {
      return json({
        contacts: Object.entries(server).map(([k, value]) => ({ kind: k, value, updatedAt: AT })),
      });
    }
    if (request.method === "PUT") {
      const { value } = JSON.parse(text) as { value: string };
      server[kind] = value.replace(/^@/, "").toLowerCase();
      return json({ kind, value: server[kind], updatedAt: AT });
    }
    delete server[kind];
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { server, calls, writes: () => calls.filter((c) => c.method !== "GET") };
}

const field = (name: string) => screen.getByLabelText(name);
const button = (name: string) => screen.getByRole("button", { name });
const disabled = (name: string) => button(name).props.accessibilityState?.disabled === true;
/** Leaves the field, as a tap elsewhere or the keyboard's Done does. */
const leave = async (name: string) => {
  await act(async () => {
    fireEvent(field(name), "blur");
  });
  await settle();
};
const type = (name: string, words: string) =>
  act(async () => {
    fireEvent.changeText(field(name), words);
  });
const press = async (name: string) => {
  await act(async () => {
    fireEvent.press(button(name));
  });
  await settle();
};
const show = async () => {
  await renderWithTheme(<YourContacts />);
  await screen.findByText(/Nobody sees them/);
};
const FAILED = "That did not go through. Try again.";
const PACE = "That was a lot in a short time. Wait a moment and try again.";
/** How a write fails, as a test's name says it, with what the card then says. */
type Failure = { how: string; answer: () => Response | Error; words: string };
const SERVER_ERROR: Failure = {
  how: "answers 500",
  answer: () => refusal("internal_error", 500),
  words: FAILED,
};
const PAST_THE_MINUTE: Failure = {
  how: "is past the minute's messages",
  answer: () => refusal("message_budget_exceeded", 429),
  words: PACE,
};
const NO_CONNECTION: Failure = {
  how: "finds no connection",
  answer: () => new TypeError("Network request failed"),
  words: FAILED,
};
const noTryAgain = () => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
/** The contacts' routes with the first write answered by `answer`, and those after it as usual. */
const firstWrite = (stored: Partial<Record<ContactKind, string>>, answer: Response | Error) =>
  contactsApi(stored, [
    json({
      contacts: Object.entries(stored).map(([kind, value]) => ({ kind, value, updatedAt: AT })),
    }),
    answer,
  ]);

beforeEach(async () => {
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
  (AccessibilityInfo.announceForAccessibilityWithOptions as jest.Mock).mockClear();
  await clearSession();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});
afterEach(() => jest.restoreAllMocks());

describe("Ways to reach you", () => {
  it("says it is loading, then a part per kind with what is kept, each field as its kind wants it", async () => {
    let answer: (response: Response) => void = () => undefined;
    contactsApi({}, [
      new Promise<Response>((resolve) => {
        answer = resolve;
      }) as unknown as Response,
    ]);
    await renderWithTheme(<YourContacts />);
    expect(screen.getByText("Loading…").props.accessibilityLiveRegion).toBe("polite");
    await act(async () =>
      answer(json({ contacts: [{ kind: "phone", value: "+358401234567", updatedAt: AT }] })),
    );
    await screen.findByText(INTRO);
    for (const title of ["Phone number", "WhatsApp", "Telegram", "Instagram", "Snapchat"]) {
      expect(screen.getByText(title)).toBeTruthy();
      // The service's mark before the title (#474), decorative.
      expect([title, markBefore(screen.toJSON() as HostNode, title)]).toEqual([title, true]);
    }
    // A hint on the phone number alone (#581): a Swedish 070 kept under +358 reaches a stranger.
    expect(drawn()).toEqual([
      INTRO,
      "Phone number",
      "Remove",
      PHONE_HINT,
      "+358",
      "WhatsApp",
      "+358",
      "Telegram",
      "Instagram",
      "Snapchat",
    ]);
    // A number is shown under its code, which stands beside the field.
    expect(field("Your phone number").props.value).toBe("40 1234567");
    expect(field("Your WhatsApp number").props.value).toBe("");
    const codes = screen.getAllByRole("button", { name: "Country code" });
    expect(codes).toHaveLength(2);
    expect(codes[0]?.props.accessibilityValue).toEqual({ text: "Finland, +358" });
    expect(codes[0]?.props.accessibilityHint).toBe("Opens the list of countries");
    for (const [name, number] of [
      ["Your phone number", true],
      ["Your WhatsApp number", true],
      ["Your Telegram username", false],
      ["Your Instagram username", false],
      ["Your Snapchat username", false],
    ] as const) {
      expect(field(name).props).toMatchObject({
        maxLength: 64,
        inputMode: number ? "tel" : "text",
        autoComplete: number ? "tel" : "off",
        autoCapitalize: "none",
        autoCorrect: false,
        returnKeyType: "done",
      });
    }
    // Remove only for the one kept, and no Save anywhere.
    expect(screen.getByRole("button", { name: "Remove your phone number" })).toBeTruthy();
    for (const name of [
      "Remove your WhatsApp number",
      "Remove your Telegram username",
      "Remove your Instagram username",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    noProblems();
  });

  it("keeps what was typed as the field is left, shows it back in its stored form, says so, and offers Remove", async () => {
    const { server, writes } = contactsApi();
    const kept = jest.fn();
    await renderWithTheme(<YourContacts onStored={kept} />);
    await screen.findByText(/Nobody sees them/);
    expect(kept).toHaveBeenLastCalledWith([]);
    await type("Your Instagram username", "  @Aino.K ");
    // Typing alone sends nothing.
    expect(writes()).toEqual([]);
    await leave("Your Instagram username");
    expect(writes()).toEqual([
      { method: "PUT", path: "/contacts/instagram", body: { value: "aino.k" } },
    ]);
    expect(server.instagram).toBe("aino.k");
    expect(field("Your Instagram username").props.value).toBe("aino.k");
    expect(screen.getByText("Saved.").props.accessibilityLiveRegion).toBe("polite");
    expect(button("Remove your Instagram username")).toBeTruthy();
    expect(kept).toHaveBeenLastCalledWith(["instagram"]);
    // Taken up again, "Saved." goes; what is kept as it is sends nothing when left.
    await act(async () => {
      fireEvent(field("Your Instagram username"), "focus");
    });
    expect(screen.queryByText("Saved.")).toBeNull();
    await type("Your Instagram username", "@AINO.K");
    await leave("Your Instagram username");
    expect(writes()).toHaveLength(1);
    expect(field("Your Instagram username").props.value).toBe("aino.k");
    // A value is in the field, never in a pressable's label.
    const labels = pressables(screen.toJSON() as HostNode).map((node) =>
      String(node.props.accessibilityLabel),
    );
    expect(labels.filter((label) => label.includes("aino"))).toEqual([]);
  });

  it.each<[string, ContactKind, string, string]>([
    ["too short a number", "phone", "12", "A digit or more seems to be missing."],
    [
      "letters for WhatsApp",
      "whatsapp",
      "my number",
      "That is not a phone number with the code +358. Check it, or choose another code.",
    ],
    [
      "a Telegram username of four",
      "telegram",
      "aino",
      "That does not look like a Telegram username: 5 to 32 letters, digits and underscores, starting with a letter.",
    ],
    [
      "an Instagram username with two dots in a row",
      "instagram",
      "aino..k",
      "That does not look like an Instagram username: up to 30 letters, digits, dots and underscores, never a dot first, last or two in a row.",
    ],
    [
      "a Snapchat username ending with a hyphen",
      "snapchat",
      "aino-",
      "That does not look like a Snapchat username: 3 to 15 letters, digits, dots, underscores and hyphens, starting with a letter and ending with a letter or a digit.",
    ],
  ])(
    "refuses %s on the phone as the field is left, before any request, in words for its kind",
    async (_what, kind, typed, said) => {
      const { writes } = contactsApi();
      await show();
      const input: Record<ContactKind, string> = {
        phone: "Your phone number",
        whatsapp: "Your WhatsApp number",
        telegram: "Your Telegram username",
        instagram: "Your Instagram username",
        snapchat: "Your Snapchat username",
      };
      await type(input[kind], typed);
      await leave(input[kind]);
      expect(screen.getByText(said).props.accessibilityLiveRegion).toBe("assertive");
      // Heard with the field too, and drawn on its outline as well as in words.
      expect(field(input[kind]).props.accessibilityHint).toBe(said);
      expect(field(input[kind]).props.className).toMatch(/\bborder-destructive\b/);
      expect(writes()).toEqual([]);
      expect(field(input[kind]).props.value).toBe(typed);
    },
  );

  it("takes a refusal away the moment the words are right, and keeps them when left", async () => {
    const { writes } = contactsApi();
    await show();
    await type("Your Telegram username", "aino");
    await leave("Your Telegram username");
    expect(screen.getByText(/^That does not look like a Telegram username/)).toBeTruthy();
    await type("Your Telegram username", "aino_");
    expect(screen.queryByText(/^That does not look like a Telegram username/)).toBeNull();
    expect(writes()).toEqual([]);
    await leave("Your Telegram username");
    expect(writes()).toEqual([
      { method: "PUT", path: "/contacts/telegram", body: { value: "aino_" } },
    ]);
  });

  it("reads a Finnish number with or without its 0 and keeps it as +358", async () => {
    const { writes } = contactsApi();
    await show();
    await type("Your phone number", "40 660 1234");
    await leave("Your phone number");
    await type("Your WhatsApp number", "040-660 12 34");
    await leave("Your WhatsApp number");
    expect(writes().map((call) => call.body)).toEqual([
      { value: "+358406601234" },
      { value: "+358406601234" },
    ]);
    expect(field("Your phone number").props.value).toBe("40 6601234");
  });

  it("names the country in Finnish in Stadi, and never asks Intl for a language it has no data for (#521)", async () => {
    const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
    store.set("kuutti.preference.locale", "fi-x-stadi");
    const real = Intl.DisplayNames;
    const names = jest
      .spyOn(Intl, "DisplayNames")
      .mockImplementation((locales, options) => new real(locales, options));
    try {
      contactsApi();
      await renderWithTheme(<YourContacts />);
      const [code] = await screen.findAllByRole("button", { name: "Maatunnus" });
      expect(code?.props.accessibilityValue).toEqual({ text: "Suomi, +358" });
      expect(names.mock.calls.flatMap(([locales]) => locales)).not.toContain("fi-x-stadi");
    } finally {
      names.mockRestore();
      store.delete("kuutti.preference.locale");
    }
  });

  it("keeps a number typed with another country's code as that country's, and shows its code", async () => {
    const { writes } = contactsApi();
    await show();
    await type("Your phone number", "+46 70 123 45 67");
    await leave("Your phone number");
    expect(writes().map((call) => call.body)).toEqual([{ value: "+46701234567" }]);
    expect(
      screen.getAllByRole("button", { name: "Country code" })[0]?.props.accessibilityValue,
    ).toEqual({
      text: "Sweden, +46",
    });
  });

  it("reads the number again under a code chosen from the list, and keeps it as the field is left", async () => {
    const { writes } = contactsApi();
    await show();
    await type("Your phone number", "070-123 45 67");
    await act(async () => {
      fireEvent.press(screen.getAllByRole("button", { name: "Country code" })[0] as never);
    });
    expect(screen.getByText("Near Finland")).toBeTruthy();
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("Search by country or code"), "swe");
    });
    const sweden = screen.getByRole("radio", { name: "Sweden, +46" });
    expect(screen.queryByRole("radio", { name: "Norway, +47" })).toBeNull();
    noProblems();
    await act(async () => {
      fireEvent.press(sweden);
    });
    expect(screen.queryByText("Near Finland")).toBeNull();
    expect(writes()).toEqual([]);
    await leave("Your phone number");
    expect(writes().map((call) => call.body)).toEqual([{ value: "+46701234567" }]);
  });

  it("lists Finland and its neighbours first, the chosen one ticked, and says when a search finds none", async () => {
    contactsApi();
    await show();
    await act(async () => {
      fireEvent.press(screen.getAllByRole("button", { name: "Country code" })[0] as never);
    });
    const near = ["Finland, +358", "Sweden, +46", "Estonia, +372", "Norway, +47"];
    const radios = screen.getAllByRole("radio").map((node) => node.props.accessibilityLabel);
    expect(radios.slice(0, 4)).toEqual(near);
    expect(
      screen.getAllByRole("radio", { name: "Finland, +358" })[0]?.props.accessibilityState,
    ).toMatchObject({
      checked: true,
    });
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("Search by country or code"), "zzz");
    });
    expect(screen.getByText("No country matches.")).toBeTruthy();
    await act(async () => {
      fireEvent.press(button("Close"));
    });
    expect(screen.queryByLabelText("Search by country or code")).toBeNull();
  });

  it("takes nothing away when a kept one is emptied and left: it comes back, and Remove is the way", async () => {
    const { writes } = contactsApi({ telegram: "aino_k" });
    await show();
    await type("Your Telegram username", "  ");
    await leave("Your Telegram username");
    expect(writes()).toEqual([]);
    expect(field("Your Telegram username").props.value).toBe("aino_k");
    expect(screen.getByText("Still saved. Remove takes it away.")).toBeTruthy();
  });

  it("says the API's refusal of a piece as the phone's own, and a failure as one, keeping the words with a way to try again", async () => {
    const { writes } = contactsApi({}, [
      json({ contacts: [] }),
      refusal("contact_invalid", 400),
      refusal("internal_error", 500),
      new TypeError("Network request failed"),
    ]);
    await show();
    await type("Your Telegram username", "aino_k");
    await leave("Your Telegram username");
    expect(
      screen.getByText(
        "That does not look like a Telegram username: 5 to 32 letters, digits and underscores, starting with a letter.",
      ),
    ).toBeTruthy();
    await type("Your Telegram username", "aino_k2");
    await leave("Your Telegram username");
    for (let i = 0; i < 2; i += 1) {
      expect(screen.getByText("That did not go through. Try again.")).toBeTruthy();
      expect(field("Your Telegram username").props.value).toBe("aino_k2");
      if (i === 0) await press("Try again");
    }
    expect(writes()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Remove your Telegram username" })).toBeNull();
  });

  it("says a keep or a removal past the messages of a minute as the share dialog does, keeping the piece and the words", async () => {
    const { server, writes } = contactsApi({ telegram: "aino_k" }, [
      json({ contacts: [{ kind: "telegram", value: "aino_k", updatedAt: AT }] }),
      refusal("message_budget_exceeded", 429),
      refusal("message_budget_exceeded", 429),
    ]);
    await show();
    await type("Your Telegram username", "aino_k2");
    await leave("Your Telegram username");
    expect(screen.getByText(PACE).props.accessibilityLiveRegion).toBe("assertive");
    expect(field("Your Telegram username").props.value).toBe("aino_k2");
    await press("Remove your Telegram username");
    expect(screen.getByText(PACE)).toBeTruthy();
    expect(button("Remove your Telegram username")).toBeTruthy();
    expect(writes()).toHaveLength(2);
    expect(server).toEqual({ telegram: "aino_k" });
  });

  it.each<["ios" | "android", ReturnType<typeof told>]>([
    ["ios", { queued: [REMOVED], plain: [] }],
    ["android", { queued: [], plain: [REMOVED] }],
  ])(
    "removes a piece on %s, says it is gone wherever it was shared, and draws nothing: its field empties and Remove goes (#581)",
    async (os, said) => {
      jest.replaceProperty(Platform, "OS", os);
      const { server, writes } = contactsApi({ phone: "+358401234567", telegram: "aino_k" });
      await show();
      await press("Remove your phone number");
      expect(writes()).toEqual([{ method: "DELETE", path: "/contacts/phone", body: null }]);
      expect(server.phone).toBeUndefined();
      expect(told()).toEqual(said);
      expect(screen.queryByText(REMOVED)).toBeNull();
      expect(field("Your phone number").props.value).toBe("");
      expect(screen.queryByRole("button", { name: "Remove your phone number" })).toBeNull();
      // The other part is as it was.
      expect(field("Your Telegram username").props.value).toBe("aino_k");
    },
  );

  it("takes the last answer's Saved. away with a removal", async () => {
    contactsApi();
    await show();
    await type("Your Telegram username", "aino_k");
    await leave("Your Telegram username");
    expect(screen.getByText("Saved.")).toBeTruthy();
    await press("Remove your Telegram username");
    expect(screen.queryByText("Saved.")).toBeNull();
    expect(told().queued.at(-1)).toBe(REMOVED);
  });

  it("says a removal that failed, and keeps the piece", async () => {
    contactsApi({ phone: "+358401234567" }, [
      json({ contacts: [{ kind: "phone", value: "+358401234567", updatedAt: AT }] }),
      refusal("internal_error", 500),
    ]);
    await show();
    await press("Remove your phone number");
    expect(screen.getByText("That did not go through. Try again.")).toBeTruthy();
    expect(told().queued).not.toContain(REMOVED);
    expect(field("Your phone number").props.value).toBe("40 1234567");
    expect(button("Remove your phone number")).toBeTruthy();
  });

  // Each kind's kept piece, read back from its field, is the piece itself: nothing to send.
  it.each<{ failure: Failure; name: string; kind: ContactKind; stored: string }>([
    { failure: SERVER_ERROR, name: "phone number", kind: "phone", stored: "+358401234567" },
    { failure: PAST_THE_MINUTE, name: "WhatsApp number", kind: "whatsapp", stored: "+46701234567" },
    { failure: NO_CONNECTION, name: "Telegram username", kind: "telegram", stored: "aino_k" },
    { failure: SERVER_ERROR, name: "Instagram username", kind: "instagram", stored: "aino.k" },
    { failure: PAST_THE_MINUTE, name: "Snapchat username", kind: "snapchat", stored: "aino-k" },
  ])(
    "draws no Try again after a removal that $failure.how, of the $name kept, and Remove sends it again",
    async ({ failure: { answer, words }, name, kind, stored }) => {
      const { server, writes } = firstWrite({ [kind]: stored }, answer());
      await show();
      const before = field(`Your ${name}`).props.value;
      await press(`Remove your ${name}`);
      expect(screen.getByText(words)).toBeTruthy();
      noTryAgain();
      expect(field(`Your ${name}`).props.value).toBe(before);
      expect(disabled(`Remove your ${name}`)).toBe(false);
      expect(server[kind]).toBe(stored);
      noProblems();
      await press(`Remove your ${name}`);
      const removal = { method: "DELETE", path: `/contacts/${kind}`, body: null };
      expect(writes()).toEqual([removal, removal]);
      expect(server[kind]).toBeUndefined();
      expect(screen.queryByText(words)).toBeNull();
      expect(field(`Your ${name}`).props.value).toBe("");
      expect(screen.queryByRole("button", { name: `Remove your ${name}` })).toBeNull();
    },
  );

  it.each<{
    failure: Failure;
    name: string;
    kind: ContactKind;
    stored?: string;
    typed: string;
    sent: string;
    shown: string;
  }>([
    {
      failure: SERVER_ERROR,
      name: "Telegram username",
      kind: "telegram",
      typed: "@aino_k2",
      sent: "aino_k2",
      shown: "aino_k2",
    },
    {
      failure: PAST_THE_MINUTE,
      name: "phone number",
      kind: "phone",
      stored: "+358401234567",
      typed: "040 765 4321",
      sent: "+358407654321",
      shown: "40 7654321",
    },
    {
      failure: NO_CONNECTION,
      name: "Instagram username",
      kind: "instagram",
      stored: "aino.k",
      typed: "@Aino.K2",
      sent: "aino.k2",
      shown: "aino.k2",
    },
  ])(
    "keeps Try again after a save that $failure.how, of the $name, and it sends the words again",
    async ({ failure: { answer, words }, name, kind, stored, typed, sent, shown }) => {
      const { server, writes } = firstWrite(stored ? { [kind]: stored } : {}, answer());
      await show();
      await type(`Your ${name}`, typed);
      await leave(`Your ${name}`);
      expect(screen.getByText(words)).toBeTruthy();
      expect(field(`Your ${name}`).props.value).toBe(typed);
      expect(server[kind]).toBe(stored);
      noProblems();
      await press("Try again");
      const save = { method: "PUT", path: `/contacts/${kind}`, body: { value: sent } };
      expect(writes()).toEqual([save, save]);
      expect(server[kind]).toBe(sent);
      expect(field(`Your ${name}`).props.value).toBe(shown);
      expect(screen.getByText("Saved.")).toBeTruthy();
      expect(screen.queryByText(words)).toBeNull();
      noTryAgain();
    },
  );

  it.each<[string, string | undefined, string]>([
    ["back at the one kept", "aino_k", "aino_k"],
    ["back at the one kept, written with its @", "aino_k", "@aino_k"],
    ["emptied, with one kept", "aino_k", ""],
    ["emptied, with none kept", undefined, ""],
    ["holding words that are refused, with one kept", "aino_k", "aino"],
    ["holding words that are refused, with none kept", undefined, "aino"],
  ])(
    "takes a failed save's Try again away from a field %s, and brings it back for words it can send",
    async (_what, stored, typed) => {
      const { writes } = firstWrite(stored ? { telegram: stored } : {}, SERVER_ERROR.answer());
      await show();
      await type("Your Telegram username", "aino_k2");
      await leave("Your Telegram username");
      expect(button("Try again")).toBeTruthy();
      await type("Your Telegram username", typed);
      noTryAgain();
      expect(writes()).toHaveLength(1);
      await type("Your Telegram username", "aino_k3");
      await press("Try again");
      expect(writes()).toEqual([
        { method: "PUT", path: "/contacts/telegram", body: { value: "aino_k2" } },
        { method: "PUT", path: "/contacts/telegram", body: { value: "aino_k3" } },
      ]);
    },
  );

  it("draws no Try again after a removal that failed with its field emptied first, and Remove still takes it away", async () => {
    const { server, writes } = firstWrite({ telegram: "aino_k" }, SERVER_ERROR.answer());
    await show();
    // The keyboard still up: a tap on Remove counts without leaving the field.
    await type("Your Telegram username", "");
    await press("Remove your Telegram username");
    expect(screen.getByText(FAILED)).toBeTruthy();
    noTryAgain();
    await press("Remove your Telegram username");
    expect(writes().map((call) => call.method)).toEqual(["DELETE", "DELETE"]);
    expect(server.telegram).toBeUndefined();
  });

  it("keeps Try again after a removal that failed with other words in the field, and it sends those words, as leaving the field would", async () => {
    const { server, writes } = firstWrite({ telegram: "aino_k" }, SERVER_ERROR.answer());
    await show();
    await type("Your Telegram username", "aino_k2");
    await press("Remove your Telegram username");
    expect(screen.getByText(FAILED)).toBeTruthy();
    await press("Try again");
    expect(writes()).toEqual([
      { method: "DELETE", path: "/contacts/telegram", body: null },
      { method: "PUT", path: "/contacts/telegram", body: { value: "aino_k2" } },
    ]);
    expect(server.telegram).toBe("aino_k2");
    expect(button("Remove your Telegram username")).toBeTruthy();
  });

  it("sends one request at a time, holds Remove and the code meanwhile, and leaves alone what was typed after it", async () => {
    let answer: (response: Response) => void = () => undefined;
    const { writes } = contactsApi({ phone: "+358401234567" }, [
      json({ contacts: [{ kind: "phone", value: "+358401234567", updatedAt: AT }] }),
      new Promise<Response>((resolve) => {
        answer = resolve;
      }) as unknown as Response,
    ]);
    await show();
    await type("Your phone number", "040 765 4321");
    await leave("Your phone number");
    expect(disabled("Remove your phone number")).toBe(true);
    expect(
      screen.getAllByRole("button", { name: "Country code" })[0]?.props.accessibilityState
        ?.disabled,
    ).toBe(true);
    // Left again while the first is on its way: nothing more is sent.
    await leave("Your phone number");
    await type("Your phone number", "040 765 4322");
    await act(async () => answer(json({ kind: "phone", value: "+358407654321", updatedAt: AT })));
    await settle();
    expect(writes()).toHaveLength(1);
    expect(field("Your phone number").props.value).toBe("040 765 4322");
    expect(disabled("Remove your phone number")).toBe(false);
  });

  it("warns before leaving a valid contact until its save succeeds", async () => {
    let answer: (response: Response) => void = () => undefined;
    contactsApi({}, [
      json({ contacts: [] }),
      new Promise<Response>((resolve) => {
        answer = resolve;
      }) as unknown as Response,
    ]);
    const report = jest.fn();
    await renderWithTheme(
      <UnsavedRow row="contacts" report={report}>
        <YourContacts />
      </UnsavedRow>,
    );
    await screen.findByText(/Nobody sees them/);
    const holds = () => report.mock.calls.filter(([, kind]) => kind === "telegram").at(-1)?.[2];
    await type("Your Telegram username", "aino_k");
    expect(holds()).toBe(true);
    await leave("Your Telegram username");
    expect(holds()).toBe(true);
    await act(async () => answer(refusal("internal_error", 500)));
    await settle();
    expect(holds()).toBe(true);
    expect(screen.getByText(FAILED)).toBeTruthy();
    await press("Try again");
    expect(holds()).toBe(false);
  });

  it("clears the row without saving discarded contacts when Settings unmounts", async () => {
    const { writes } = contactsApi();
    const report = jest.fn();
    const view = await renderWithTheme(
      <UnsavedRow row="contacts" report={report}>
        <YourContacts />
      </UnsavedRow>,
    );
    await screen.findByText(/Nobody sees them/);
    await type("Your Telegram username", "aino");
    await leave("Your Telegram username");
    expect(report).toHaveBeenCalledWith("contacts", "telegram", true);
    await type("Your Instagram username", "aino.k");
    await view.rerender(
      underProviders(
        <UnsavedRow row="contacts" report={report}>
          {null}
        </UnsavedRow>,
      ),
    );
    await settle();
    expect(writes()).toEqual([]);
    // Gone, the fields hold nothing for the row any more.
    expect(report).toHaveBeenCalledWith("contacts", "telegram", false);
  });

  it("says the read failed, why, and reads again with Try again", async () => {
    contactsApi({ instagram: "aino.k" }, [refusal("internal_error", 500)]);
    await renderWithTheme(<YourContacts />);
    expect(await screen.findByText(FAILED_TO_LOAD)).toBeTruthy();
    noProblems();
    await press("Try again");
    await waitFor(() => expect(field("Your Instagram username").props.value).toBe("aino.k"));
  });

  it("speaks Finnish on a Finnish phone", async () => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: "fi-FI" }]);
    contactsApi({ whatsapp: "+358401234567" });
    await renderWithTheme(<YourContacts />);
    expect(await screen.findByText("Puhelinnumero")).toBeTruthy();
    expect(
      screen.getByText(
        "Kukaan ei näe niitä, ennen kuin jaat jonkin niistä keskustelussa. Muutos tai poisto näkyy heti kaikkialla, missä olet sen jakanut.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Toisen maan numerolle valitse ensin sen maatunnus.")).toBeTruthy();
    expect(field("WhatsApp-numerosi").props.value).toBe("40 1234567");
    expect(button("Poista WhatsApp-numerosi")).toBeTruthy();
    expect(
      within(screen.getAllByRole("button", { name: "Maatunnus" })[0] as never).getByText("+358"),
    ).toBeTruthy();
    await type("Instagram-käyttäjänimesi", "a..b");
    await leave("Instagram-käyttäjänimesi");
    expect(
      screen.getByText(
        "Tämä ei näytä Instagram-käyttäjänimeltä: enintään 30 kirjainta, numeroa, pistettä tai alaviivaa. Piste ei voi olla ensimmäisenä, viimeisenä eikä kahdesti peräkkäin.",
      ),
    ).toBeTruthy();
  });
});
