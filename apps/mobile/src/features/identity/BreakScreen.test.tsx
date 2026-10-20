import { act, fireEvent, screen } from "@testing-library/react-native";
import type * as React from "react";
import { clearSession, currentSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { BreakScreen } from "./BreakScreen";

// The break screen (#170, ADR-022): three lines, a switch that says "I
// understand", a button that waits for it, and the device signed out when
// the API says 204; a refusal keeps the session and says so.

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { back: jest.Mock; replace: jest.Mock };
};
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const session = {
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token("access"),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: token("refresh"),
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
};
const UNDERSTAND = "I understand what a break means";
const START = "Start the break";
const settle = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));
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
const tick = () =>
  act(async () => {
    fireEvent(screen.getByLabelText(UNDERSTAND), "press");
    await settle();
  });
const disabled = (name: string) =>
  screen.getByRole("button", { name }).props.accessibilityState?.disabled === true;

/** The API's answer to the one call the screen makes. */
function serve(status: number) {
  const calls: { path: string; body: unknown }[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push({ path: new URL(request.url).pathname, body: JSON.parse(await request.text()) });
    if (status === 204) return new Response(null, { status });
    return new Response(
      JSON.stringify({ error: { code: "internal_error", message: "x", requestId: "r" } }),
      { status, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(async () => {
  router.back.mockReset();
  await saveSession(session);
});
afterEach(async () => {
  await clearSession();
});

describe("BreakScreen", () => {
  it("keeps the title and the way back pinned above what it says", async () => {
    await show(<BreakScreen />);
    expectPinnedHeader("Take a break from Kuutti", "Back");
  });

  it("says the three things that happen, and the button waits for the tick", async () => {
    await show(<BreakScreen />);
    expect(screen.getByRole("heading", { name: "Take a break from Kuutti" })).toBeTruthy();
    for (const line of [
      /leaves everybody's view/,
      /signed out on every device/,
      /brings you back/,
      // A break stops no clock: a waiting like can still run out (#97), a
      // quiet match is still put away (#100).
      /a like waiting for you can run out, and a quiet conversation moves to Archived/,
    ]) {
      expect(screen.getByText(line)).toBeTruthy();
    }
    expect(disabled(START)).toBe(true);
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
    await tick();
    expect(screen.getByLabelText(UNDERSTAND).props.accessibilityState?.checked).toBe(true);
    expect(disabled(START)).toBe(false);
    // No deleting from here: that button lives elsewhere, behind its own question.
    expect(screen.queryByRole("button", { name: /[Dd]elete/ })).toBeNull();
  });

  it("pauses the account with the confirmation and signs the device out", async () => {
    const calls = serve(204);
    await show(<BreakScreen />);
    await tick();
    await press(screen.getByRole("button", { name: START }));
    expect(calls).toEqual([{ path: "/account/pause", body: { confirm: true } }]);
    expect(currentSession()).toBeNull();
  });

  it("keeps the session and says so when the break could not be started", async () => {
    serve(500);
    await show(<BreakScreen />);
    await tick();
    await press(screen.getByRole("button", { name: START }));
    expect(screen.getByText("The break could not be started. Try again.")).toBeTruthy();
    expect(currentSession()).not.toBeNull();
    expect(disabled(START)).toBe(false);
  });

  it("goes back from its arrow", async () => {
    await show(<BreakScreen />);
    await press(screen.getByRole("button", { name: "Back" }));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("toggles the switch from its label too, both ways", async () => {
    await show(<BreakScreen />);
    const checked = () => screen.getByLabelText(UNDERSTAND).props.accessibilityState?.checked;
    await press(screen.getByText(UNDERSTAND));
    expect(checked()).toBe(true);
    await press(screen.getByText(UNDERSTAND));
    expect(checked()).toBe(false);
  });
});
