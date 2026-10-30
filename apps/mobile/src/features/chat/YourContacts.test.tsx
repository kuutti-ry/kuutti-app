import type { ContactKind } from "@kuutti/schema";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { clearSession, saveSession } from "@/lib/session";
import { UnsavedRow } from "@/lib/unsaved";
import { a11yProblems, type HostNode, markBefore, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import { YourContacts } from "./YourContacts";

// The contacts a person keeps (#103), under Settings' Ways to reach you row
// (#511): the read with its loading line and its failure, a part per kind
// with its field as the kind wants it, a number's country code beside its
// field, no Save (leaving the field keeps it), the phone's own check before
// the API's, the stored form shown back, Remove only while one is kept, each
// outcome said in words, and no value in a pressable's label.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const AT = "2026-10-18T09:00:00.000Z";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);

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

beforeEach(async () => {
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  await clearSession();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("Ways to reach you", () => {
  it("says it is loading, then a part per kind with what is kept, each field as its kind wants it", async () => {
    let answer: (response: Response) => void = () => undefined;
    contactsApi({}, [
      new Promise<Response>((resolve) => {
        answer = resolve;
      }) as unknown as Response,
    ]);
    await renderWithTheme(<YourContacts />);
    expect(screen.getByText("Loading your contact details…").props.accessibilityLiveRegion).toBe(
      "polite",
    );
    await act(async () =>
      answer(json({ contacts: [{ kind: "phone", value: "+358401234567", updatedAt: AT }] })),
    );
    await screen.findByText(
      "Keep the ways to reach you outside the app here. Nobody sees them until you share one in a conversation, with the button at its top. A change or a removal shows at once wherever you shared it.",
    );
    for (const title of ["Phone number", "WhatsApp", "Telegram", "Instagram", "Snapchat"]) {
      expect(screen.getByText(title)).toBeTruthy();
      // The service's mark before the title (#474), decorative.
      expect([title, markBefore(screen.toJSON() as HostNode, title)]).toEqual([title, true]);
    }
    expect(
      screen.getByText(
        "With or without the 0 at the start. For another country's number, choose its code first.",
      ),
    ).toBeTruthy();
    expect(screen.getAllByText("Your username, with or without the @ before it.")).toHaveLength(3);
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
    expect(
      screen.getByText("No country matches. Search by name or by code, such as 46."),
    ).toBeTruthy();
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
      expect(
        screen.getByText("Nothing changed. Check your connection and try again."),
      ).toBeTruthy();
      expect(field("Your Telegram username").props.value).toBe("aino_k2");
      if (i === 0) await press("Try again");
    }
    expect(writes()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Remove your Telegram username" })).toBeNull();
  });

  it("says a keep or a removal past the messages of a minute as the share dialog does, keeping the piece and the words", async () => {
    const PACE = "That was a lot in a short time. Wait a moment and try again.";
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

  it("removes a piece, says it is gone wherever it was shared, and empties its field", async () => {
    const { server, writes } = contactsApi({ phone: "+358401234567", telegram: "aino_k" });
    await show();
    await press("Remove your phone number");
    expect(writes()).toEqual([{ method: "DELETE", path: "/contacts/phone", body: null }]);
    expect(server.phone).toBeUndefined();
    expect(screen.getByText("Removed. Wherever you shared it, it is gone now.")).toBeTruthy();
    expect(field("Your phone number").props.value).toBe("");
    expect(screen.queryByRole("button", { name: "Remove your phone number" })).toBeNull();
    // The other part is as it was.
    expect(field("Your Telegram username").props.value).toBe("aino_k");
  });

  it("says a removal that failed, and keeps the piece", async () => {
    contactsApi({ phone: "+358401234567" }, [
      json({ contacts: [{ kind: "phone", value: "+358401234567", updatedAt: AT }] }),
      refusal("internal_error", 500),
    ]);
    await show();
    await press("Remove your phone number");
    expect(screen.getByText("Nothing changed. Check your connection and try again.")).toBeTruthy();
    expect(field("Your phone number").props.value).toBe("40 1234567");
    expect(button("Remove your phone number")).toBeTruthy();
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

  it("sends a right change not sent yet as Settings is left, and tells the row what is not kept", async () => {
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
    expect(writes()).toEqual([
      { method: "PUT", path: "/contacts/instagram", body: { value: "aino.k" } },
    ]);
    // Gone, the fields hold nothing for the row any more.
    expect(report).toHaveBeenCalledWith("contacts", "telegram", false);
  });

  it("says the read failed, why, and reads again with Try again", async () => {
    contactsApi({ instagram: "aino.k" }, [refusal("internal_error", 500)]);
    await renderWithTheme(<YourContacts />);
    expect(await screen.findByText("Your contact details could not be loaded.")).toBeTruthy();
    noProblems();
    await press("Try again");
    await waitFor(() => expect(field("Your Instagram username").props.value).toBe("aino.k"));
  });

  it("speaks Finnish on a Finnish phone", async () => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: "fi-FI" }]);
    contactsApi({ whatsapp: "+358401234567" });
    await renderWithTheme(<YourContacts />);
    expect(await screen.findByText("Puhelinnumero")).toBeTruthy();
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
