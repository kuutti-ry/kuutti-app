import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { FoundThemScreen } from "./FoundThemScreen";

// "Löysin hänet" (#83, ADR-040): the three reasons in words, Tell Kuutti off
// until one is chosen, nothing pressable while the answer is on its way,
// thanks after the answer, an account that answered before thanked and never
// asked again, a second answer read as done, a failure that keeps the choice,
// and nothing for a device without a session.

jest.mock("nativewind", () => ({
  ...jest.requireActual("nativewind"),
  useColorScheme: () => ({ colorScheme: "light", setColorScheme: jest.fn() }),
}));

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const tokens = {
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token("access"),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: `${token("family")}.${token("refresh")}`,
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);

type Sent = { method: string; body: unknown };
/** The API as the screen sees it: the read answered as told, every answer recorded. */
function api(answered: boolean | "fails", answer: () => Response | Promise<Response>) {
  const sent: Sent[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname !== "/account/found-them") {
      return json({ error: { code: "not_found" } }, 404);
    }
    if (request.method === "GET") {
      return answered === "fails"
        ? json({ error: { code: "internal_error" } }, 500)
        : json({ answered });
    }
    const text = await request.text();
    sent.push({ method: request.method, body: text ? JSON.parse(text) : null });
    return answer();
  }) as unknown as typeof fetch;
  return sent;
}
const press = (name: string, role: "button" | "radio" = "button") =>
  act(async () => {
    fireEvent.press(screen.getByRole(role, { name }));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  });
const tellButton = () => screen.getByRole("button", { name: /^(Tell Kuutti|Sending)/ });
const thanked = () =>
  waitFor(() =>
    expect(screen.getByRole("heading", { name: "Thank you for telling us." })).toBeTruthy(),
  );

beforeEach(async () => {
  store.clear();
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  await clearSession();
});

describe("the found-them screen", () => {
  it("asks which it is, sends the chosen reason, and thanks the person", async () => {
    const sent = api(false, () => new Response(null, { status: 204 }));
    await saveSession(tokens);
    await renderWithTheme(<FoundThemScreen />);
    await screen.findByRole("radio", { name: "I found someone on Kuutti" });

    expectPinnedHeader("I found someone", "Back");
    expect(screen.getByRole("heading", { name: "Which is it?" })).toBeTruthy();
    // The question names the group of choices for a screen reader too.
    expect(screen.getByLabelText("Which is it?").props.accessibilityRole).toBe("radiogroup");
    expect(screen.getByText(/Nothing changes in the app/)).toBeTruthy();
    noProblems();
    expect(tellButton().props.accessibilityState?.disabled).toBe(true);

    await press("I found someone elsewhere", "radio");
    expect(screen.getByRole("radio", { name: "✓ I found someone elsewhere" })).toBeTruthy();
    expect(tellButton().props.accessibilityState?.disabled).toBe(false);
    await press("Tell Kuutti");

    await thanked();
    expect(sent).toEqual([{ method: "POST", body: { reason: "elsewhere" } }]);
    expect(screen.queryByRole("radio")).toBeNull();
    noProblems();
  });

  it("thanks an account that told Kuutti before, and never asks again", async () => {
    const sent = api(true, () => new Response(null, { status: 204 }));
    await saveSession(tokens);
    await renderWithTheme(<FoundThemScreen />);
    await thanked();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByText(/Nothing changes in the app/)).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it("reads a second answer, refused by the API, as told", async () => {
    api(false, () =>
      json({ error: { code: "found_them_answered", message: "Told", requestId: "r1" } }, 409),
    );
    await saveSession(tokens);
    await renderWithTheme(<FoundThemScreen />);
    await press("I found someone on Kuutti", "radio");
    await press("Tell Kuutti");
    await thanked();
  });

  it("keeps the choice after a failure, says so, and sends again", async () => {
    let fail = true;
    const sent = api(false, () =>
      fail ? json({ error: { code: "internal_error" } }, 500) : new Response(null, { status: 204 }),
    );
    await saveSession(tokens);
    await renderWithTheme(<FoundThemScreen />);
    await press("Another reason", "radio");
    await press("Tell Kuutti");
    const failed = await screen.findByText(
      "That did not go through. Your choice is kept; try again.",
    );
    // Said at once by a screen reader, wherever its focus is.
    expect(failed.props.accessibilityLiveRegion).toBe("assertive");
    expect(screen.getByRole("radio", { name: "✓ Another reason" })).toBeTruthy();
    fail = false;
    await press("Tell Kuutti");
    await thanked();
    expect(sent.map((s) => (s.body as { reason: string }).reason)).toEqual(["other", "other"]);
  });

  it("holds the choice and the button while the answer is on its way", async () => {
    let arrive: (response: Response) => void = () => undefined;
    const sent = api(false, () => new Promise<Response>((resolve) => (arrive = resolve)));
    await saveSession(tokens);
    await renderWithTheme(<FoundThemScreen />);
    await press("I found someone on Kuutti", "radio");
    await press("Tell Kuutti");

    const sending = screen.getByRole("button", { name: "Sending…" });
    expect(sending.props.accessibilityState?.disabled).toBe(true);
    for (const name of ["✓ I found someone on Kuutti", "I found someone elsewhere"]) {
      expect(screen.getByRole("radio", { name }).props.accessibilityState?.disabled).toBe(true);
    }
    await press("I found someone elsewhere", "radio");
    expect(screen.getByRole("radio", { name: "✓ I found someone on Kuutti" })).toBeTruthy();

    await act(async () => arrive(new Response(null, { status: 204 })));
    await thanked();
    expect(sent).toEqual([{ method: "POST", body: { reason: "here" } }]);
  });

  it("asks when the read fails, rather than leaving the person waiting", async () => {
    api("fails", () => new Response(null, { status: 204 }));
    await saveSession(tokens);
    await renderWithTheme(<FoundThemScreen />);
    expect(await screen.findByRole("radio", { name: "Another reason" })).toBeTruthy();
  });

  it("says there is no session on a device without one, and asks nothing", async () => {
    api(false, () => new Response(null, { status: 204 }));
    await renderWithTheme(<FoundThemScreen />);
    expect(await screen.findByText("No session on this device.")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Tell Kuutti" })).toBeNull();
    // Not even the read is asked.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
