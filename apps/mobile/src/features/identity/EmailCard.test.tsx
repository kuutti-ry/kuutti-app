import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import type * as React from "react";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { EmailCard, EmailScreen } from "./EmailCard";

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock };
};
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

/** A tiny server for the e-mail: read, set with the API's own validation, cleared. */
function fakeApi(initial: string | null = null) {
  const server = { email: initial };
  const calls: { method: string; body: unknown }[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path !== "/account/email") {
      return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
    }
    if (request.method === "GET") return json({ email: server.email });
    if (request.method === "PUT") {
      const body = (await request.json()) as { email: string };
      calls.push({ method: "PUT", body });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) {
        return json({ error: { code: "validation_failed", message: "no", requestId: "r" } }, 400);
      }
      server.email = body.email;
      return new Response(null, { status: 204 });
    }
    calls.push({ method: "DELETE", body: undefined });
    server.email = null;
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { server, calls };
}

beforeEach(async () => {
  router.replace.mockReset();
  router.push.mockReset();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("EmailCard", () => {
  it("saves an address, shows that one is set, removes it, and says when the API refuses one", async () => {
    const { server, calls } = fakeApi();
    await show(<EmailCard />);
    await waitFor(() => expect(screen.getByText("A way back in")).toBeTruthy());
    expect(screen.getByText(/never a login/)).toBeTruthy();
    expect(screen.queryByText("An address is set.")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Save the address" }).props.accessibilityState?.disabled,
    ).toBe(true);
    await type(screen.getByLabelText("E-mail address"), "aino@example.fi");
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
    await press(screen.getByRole("button", { name: "Save the address" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    expect(screen.getByText("An address is set.")).toBeTruthy();
    expect(server.email).toBe("aino@example.fi");
    await press(screen.getByRole("button", { name: "Remove the address" }));
    await waitFor(() => expect(screen.queryByText("An address is set.")).toBeNull());
    expect(server.email).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(["PUT", "DELETE"]);
    await type(screen.getByLabelText("E-mail address"), "aino");
    await press(screen.getByRole("button", { name: "Save the address" }));
    await waitFor(() =>
      expect(screen.getByText("That does not look like an e-mail address.")).toBeTruthy(),
    );
    expect(server.email).toBeNull();
  });

  it("as the last of the later screens, leads home", async () => {
    fakeApi("aino@example.fi");
    await show(<EmailScreen />);
    await waitFor(() => expect(screen.getByText("An address is set.")).toBeTruthy());
    expect(screen.getByText("That is everything. Thank you.")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Done" }));
    expect(router.replace).toHaveBeenCalledWith("/");
  });

  it("says the address could not be saved when the API fails, as opposed to refusing it", async () => {
    fakeApi();
    const answers = globalThis.fetch;
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return request.method === "PUT" ? refusal("internal_error", 500) : answers(input, init);
    }) as unknown as typeof fetch;
    await show(<EmailCard />);
    await waitFor(() => expect(screen.getByLabelText("E-mail address")).toBeTruthy());
    await type(screen.getByLabelText("E-mail address"), "aino@example.fi");
    await press(screen.getByRole("button", { name: "Save the address" }));
    expect(screen.getByText("The address could not be saved. Try again.")).toBeTruthy();
    expect(screen.queryByText("That does not look like an e-mail address.")).toBeNull();
    // Typing again clears the line.
    await type(screen.getByLabelText("E-mail address"), "aino@example.org");
    expect(screen.queryByText("The address could not be saved. Try again.")).toBeNull();
  });

  it("does not offer to save the address that is already stored", async () => {
    fakeApi("aino@example.fi");
    await show(<EmailCard />);
    await waitFor(() => expect(screen.getByText("An address is set.")).toBeTruthy());
    expect(screen.getByLabelText("E-mail address").props.value).toBe("aino@example.fi");
    expect(
      screen.getByRole("button", { name: "Save the address" }).props.accessibilityState?.disabled,
    ).toBe(true);
  });

  it("shows nothing when the address cannot be read", async () => {
    globalThis.fetch = jest.fn(async () =>
      refusal("internal_error", 500),
    ) as unknown as typeof fetch;
    await show(<EmailCard />);
    expect(screen.queryByText("A way back in")).toBeNull();
  });

  it("shows nothing and asks nothing for a signed-out device", async () => {
    await clearSession();
    fakeApi();
    await show(<EmailCard />);
    expect(screen.queryByText("A way back in")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("as the last of the later screens, offers the deal-breakers on the way", async () => {
    fakeApi();
    await show(<EmailScreen />);
    await press(screen.getByRole("button", { name: "Your deal-breakers" }));
    expect(router.push).toHaveBeenCalledWith("/profile/deal-breakers");
  });
});
