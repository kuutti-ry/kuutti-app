import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import type * as React from "react";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { ProfileScreen } from "./ProfileScreen";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
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

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * GET /profile answering each read with the next list of what is missing, the
 * last one again after that. `tip` is the advisory kind of #56 (null by default).
 */
function fakeApi(missingByRead: string[][], tip: string | null = null) {
  let reads = 0;
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/profile" && request.method === "GET") {
      const missing = missingByRead[Math.min(reads, missingByRead.length - 1)] ?? [];
      reads += 1;
      return json({
        profile: null,
        completeness: { complete: missing.length === 0, missing },
        tip,
      });
    }
    return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
  }) as unknown as typeof fetch;
  return { reads: () => reads };
}

const { __router: router, __focus: focus } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; back: jest.Mock };
  __focus: () => void;
};

beforeEach(async () => {
  router.push.mockClear();
  router.back.mockClear();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("ProfileScreen", () => {
  it("lists the sections with what each holds, after what the card still needs, every row labelled", async () => {
    fakeApi([["display_name", "photos"]]);
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText("The basics")).toBeTruthy());
    expect(screen.getByText("At least 2 approved photos")).toBeTruthy();
    for (const title of [
      "Prompts",
      "Relationship and kids",
      "Work and education",
      "Lifestyle",
      "Hobbies",
      "Beliefs",
    ]) {
      expect(screen.getByRole("button", { name: title })).toBeTruthy();
    }
    expect(screen.getByText("Smoking, drinking, drugs, exercise and pets")).toBeTruthy();
    // Nothing is edited on the list, so there is nothing to save.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryAllByText(/^profile\./)).toEqual([]);
    const found = pressables(screen.toJSON() as HostNode);
    // The back arrow, seven sections, and the card, the later questions and the deal-breakers.
    expect(found).toHaveLength(11);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  });

  it("shows one tip under the completeness card and dismisses it for the session", async () => {
    fakeApi([[]], "sunglasses");
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText("A tip for your photos")).toBeTruthy());
    expect(screen.getByText(/without sunglasses/)).toBeTruthy();
    expect(screen.queryAllByText(/^profile\.tip\./)).toEqual([]);
    const found = pressables(screen.toJSON() as HostNode);
    // The eleven list rows plus the tip's dismiss.
    expect(found).toHaveLength(12);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    await press(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText("A tip for your photos")).toBeNull();
  });

  it("opens a section, the card, the later questions and the deal-breakers", async () => {
    fakeApi([[]]);
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText("Lifestyle")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Lifestyle" }));
    await press(screen.getByRole("button", { name: "See your card" }));
    await press(screen.getByRole("button", { name: "Fill in the rest while you wait" }));
    await press(screen.getByRole("button", { name: "Your deal-breakers" }));
    expect(router.push.mock.calls.map(([path]) => path)).toEqual([
      "/profile/section/lifestyle",
      "/profile/card",
      expect.stringMatching(/^\/profile\/later\//),
      "/profile/deal-breakers",
    ]);
  });

  it("reads the profile again when a section hands back, and the checklist follows", async () => {
    const api = fakeApi([["display_name", "photos"], ["photos"]]);
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText("A name on the card")).toBeTruthy());
    expect(api.reads()).toBe(1);
    await act(async () => {
      focus();
      await settle();
    });
    expect(api.reads()).toBe(2);
    expect(screen.queryByText("A name on the card")).toBeNull();
    // The list stays while it reads: no loading screen in between.
    expect(screen.getByText("At least 2 approved photos")).toBeTruthy();
  });
});
