import type { ContactKind } from "@kuutti/schema";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { YourContacts } from "./YourContacts";

// The contacts a person keeps (#103), on Settings' Your contacts screen: the
// read with its loading line and its failure, a card per kind with its field
// as the kind wants it, Save off while empty or unchanged, the phone's own
// check before the API's, the stored form shown back, Remove only while one
// is kept, each outcome said in words, and no value in a pressable's label.

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
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("Your contacts", () => {
  it("says it is loading, then a card per kind with what is kept, each field as its kind wants it", async () => {
    let answer: (response: Response) => void = () => undefined;
    contactsApi({}, [
      new Promise<Response>((resolve) => {
        answer = resolve;
      }) as unknown as Response,
    ]);
    await renderWithTheme(<YourContacts />);
    expect(screen.getByText("Loading your contacts…").props.accessibilityLiveRegion).toBe("polite");
    await act(async () =>
      answer(json({ contacts: [{ kind: "phone", value: "+358401234567", updatedAt: AT }] })),
    );
    await screen.findByText(
      "Keep the ways to reach you outside the app here. Nobody sees them until you share one in a conversation, with the button at its top. A change or a removal shows at once wherever you shared it.",
    );
    for (const title of ["Phone number", "WhatsApp", "Telegram", "Instagram"]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(
      screen.getByText("A number with its country code, or a Finnish one starting with 0."),
    ).toBeTruthy();
    expect(screen.getAllByText("Your username, with or without the @ before it.")).toHaveLength(2);
    expect(field("Your phone number").props.value).toBe("+358401234567");
    expect(field("Your WhatsApp number").props.value).toBe("");
    for (const [name, number] of [
      ["Your phone number", true],
      ["Your WhatsApp number", true],
      ["Your Telegram username", false],
      ["Your Instagram username", false],
    ] as const) {
      expect(field(name).props).toMatchObject({
        maxLength: 64,
        inputMode: number ? "tel" : "text",
        autoComplete: number ? "tel" : "off",
        autoCapitalize: "none",
        autoCorrect: false,
      });
    }
    // Remove only for the one kept; Save off while unchanged or empty.
    expect(screen.getByRole("button", { name: "Remove your phone number" })).toBeTruthy();
    for (const name of [
      "Remove your WhatsApp number",
      "Remove your Telegram username",
      "Remove your Instagram username",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    for (const name of [
      "Save your phone number",
      "Save your WhatsApp number",
      "Save your Telegram username",
      "Save your Instagram username",
    ]) {
      expect(disabled(name)).toBe(true);
    }
    noProblems();
  });

  it("keeps what was typed, shows it back in its stored form, says so, and offers Remove", async () => {
    const { server, writes } = contactsApi();
    await show();
    await type("Your Instagram username", "  @Aino.K ");
    expect(disabled("Save your Instagram username")).toBe(false);
    await press("Save your Instagram username");
    expect(writes()).toEqual([
      { method: "PUT", path: "/contacts/instagram", body: { value: "@Aino.K" } },
    ]);
    expect(server.instagram).toBe("aino.k");
    expect(field("Your Instagram username").props.value).toBe("aino.k");
    expect(screen.getByText("Saved.").props.accessibilityLiveRegion).toBe("assertive");
    expect(button("Remove your Instagram username")).toBeTruthy();
    expect(disabled("Save your Instagram username")).toBe(true);
    // What would be stored as it is already is no change: Save stays off; typing takes the notice away.
    await type("Your Instagram username", "@AINO.K");
    expect(disabled("Save your Instagram username")).toBe(true);
    expect(screen.queryByText("Saved.")).toBeNull();
    await type("Your Instagram username", "aino.k2");
    expect(disabled("Save your Instagram username")).toBe(false);
    // A value is in the field, never in a pressable's label.
    const labels = pressables(screen.toJSON() as HostNode).map((node) =>
      String(node.props.accessibilityLabel),
    );
    expect(labels.filter((label) => label.includes("aino"))).toEqual([]);
  });

  it.each<[string, ContactKind, string, string]>([
    [
      "too short a number",
      "phone",
      "12",
      "That does not look like a phone number. Write it with its country code (+358…) or as a Finnish number starting with 0.",
    ],
    [
      "letters for WhatsApp",
      "whatsapp",
      "my number",
      "That does not look like a phone number. Write it with its country code (+358…) or as a Finnish number starting with 0.",
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
  ])(
    "refuses %s on the phone, before any request, in words for its kind",
    async (_what, kind, typed, said) => {
      const { writes } = contactsApi();
      await show();
      const names: Record<ContactKind, [string, string]> = {
        phone: ["Your phone number", "Save your phone number"],
        whatsapp: ["Your WhatsApp number", "Save your WhatsApp number"],
        telegram: ["Your Telegram username", "Save your Telegram username"],
        instagram: ["Your Instagram username", "Save your Instagram username"],
      };
      const [input, save] = names[kind];
      await type(input, typed);
      await press(save);
      expect(screen.getByText(said).props.accessibilityLiveRegion).toBe("assertive");
      expect(writes()).toEqual([]);
      expect(field(input).props.value).toBe(typed);
    },
  );

  it("says the API's refusal of a piece as the phone's own, and a failure as one, keeping the words", async () => {
    const { writes } = contactsApi({}, [
      json({ contacts: [] }),
      refusal("contact_invalid", 400),
      refusal("internal_error", 500),
      new TypeError("Network request failed"),
    ]);
    await show();
    await type("Your Telegram username", "aino_k");
    await press("Save your Telegram username");
    expect(
      screen.getByText(
        "That does not look like a Telegram username: 5 to 32 letters, digits and underscores, starting with a letter.",
      ),
    ).toBeTruthy();
    for (let i = 0; i < 2; i += 1) {
      await press("Save your Telegram username");
      expect(
        screen.getByText("Nothing changed. Check your connection and try again."),
      ).toBeTruthy();
      expect(field("Your Telegram username").props.value).toBe("aino_k");
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
    await press("Save your Telegram username");
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
    expect(
      screen.getByText("Removed. Wherever you shared it, it is gone now.").props
        .accessibilityLiveRegion,
    ).toBe("assertive");
    expect(field("Your phone number").props.value).toBe("");
    expect(screen.queryByRole("button", { name: "Remove your phone number" })).toBeNull();
    // The other card is as it was.
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
    expect(field("Your phone number").props.value).toBe("+358401234567");
    expect(button("Remove your phone number")).toBeTruthy();
  });

  it("turns Save and Remove off while a save is on its way", async () => {
    let answer: (response: Response) => void = () => undefined;
    contactsApi({ phone: "+358401234567" }, [
      json({ contacts: [{ kind: "phone", value: "+358401234567", updatedAt: AT }] }),
      new Promise<Response>((resolve) => {
        answer = resolve;
      }) as unknown as Response,
    ]);
    await show();
    await type("Your phone number", "040 765 4321");
    await act(async () => {
      fireEvent.press(button("Save your phone number"));
    });
    expect(disabled("Save your phone number")).toBe(true);
    expect(disabled("Remove your phone number")).toBe(true);
    await act(async () => answer(json({ kind: "phone", value: "+358407654321", updatedAt: AT })));
    await settle();
    expect(field("Your phone number").props.value).toBe("+358407654321");
    expect(disabled("Remove your phone number")).toBe(false);
  });

  it("says the read failed, why, and reads again with Try again", async () => {
    contactsApi({ instagram: "aino.k" }, [refusal("internal_error", 500)]);
    await renderWithTheme(<YourContacts />);
    expect(await screen.findByText("Your contacts could not be loaded.")).toBeTruthy();
    noProblems();
    await press("Try again");
    await waitFor(() => expect(field("Your Instagram username").props.value).toBe("aino.k"));
  });

  it("speaks Finnish on a Finnish phone", async () => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: "fi-FI" }]);
    contactsApi({ whatsapp: "+358401234567" });
    await renderWithTheme(<YourContacts />);
    expect(await screen.findByText("Puhelinnumero")).toBeTruthy();
    expect(field("WhatsApp-numerosi").props.value).toBe("+358401234567");
    expect(button("Poista WhatsApp-numerosi")).toBeTruthy();
    await type("Instagram-käyttäjänimesi", "a..b");
    await press("Tallenna Instagram-käyttäjänimesi");
    expect(
      screen.getByText(
        "Tämä ei näytä Instagram-käyttäjänimeltä: enintään 30 kirjainta, numeroa, pistettä tai alaviivaa. Piste ei voi olla ensimmäisenä, viimeisenä eikä kahdesti peräkkäin.",
      ),
    ).toBeTruthy();
  });
});
