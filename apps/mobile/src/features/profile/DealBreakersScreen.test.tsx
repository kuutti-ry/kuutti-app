import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import type * as React from "react";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { DealBreakersScreen } from "./DealBreakersScreen";

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock };
};
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
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);

type DealBreaker = { field: string; accept: string[]; includeUnknown: boolean };

/** A tiny server: the profile for the own answers, the deal-breakers read and replaced whole, paused read off the profile. */
function fakeApi(fields: Record<string, unknown>, dealBreakers: DealBreaker[] = [], max = 2) {
  const server = { fields, dealBreakers };
  const puts: DealBreaker[][] = [];
  const stored = () => ({
    dealBreakers: server.dealBreakers.map((d) => ({
      ...d,
      paused: server.fields[d.field] === undefined,
    })),
    max,
  });
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/profile" && request.method === "GET") {
      return json({
        profile: {
          displayName: "Aino",
          bio: null,
          bioPreset: null,
          fields: server.fields,
          prompts: [],
          specialCategoryConsent: null,
          updatedAt: "2026-10-08T10:00:00.000Z",
        },
        completeness: { complete: false, missing: ["photos"] },
      });
    }
    if (path === "/preferences/deal-breakers" && request.method === "GET") return json(stored());
    if (path === "/preferences/deal-breakers" && request.method === "PUT") {
      const body = (await request.json()) as { dealBreakers: DealBreaker[] };
      puts.push(body.dealBreakers);
      server.dealBreakers = body.dealBreakers;
      return json(stored());
    }
    return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
  }) as unknown as typeof fetch;
  return { server, puts };
}

const answeredAll = {
  monogamy: "monogamous",
  hasKids: "no",
  wantsKids: "want",
  smoking: "never",
  languages: ["fi"],
};

const checkA11y = () => {
  const found = pressables(screen.toJSON() as HostNode);
  expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
};

beforeEach(async () => {
  router.push.mockReset();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("DealBreakersScreen", () => {
  it("gates a field the person has not answered and leads to its screen", async () => {
    fakeApi({ ...answeredAll, hasKids: undefined });
    await show(<DealBreakersScreen />);
    await waitFor(() => expect(screen.getByText("Deal-breakers")).toBeTruthy());
    expect(screen.getByText(/Up to 2\./)).toBeTruthy();
    // Four switches for the four answered fields; the fifth asks for the answer first.
    expect(screen.getAllByRole("switch")).toHaveLength(4);
    expect(screen.queryByLabelText("Deal-breaker: Kids")).toBeNull();
    expect(screen.getAllByText("To filter on this, share yours first.")).toHaveLength(1);
    checkA11y();
    await press(screen.getByRole("button", { name: "Answer it" }));
    expect(router.push).toHaveBeenCalledWith("/profile/later/hasKids");
  });

  it("leads a field without a later screen to the profile screen", async () => {
    fakeApi({ ...answeredAll, monogamy: undefined });
    await show(<DealBreakersScreen />);
    await waitFor(() => expect(screen.getByText("Deal-breakers")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Answer it" }));
    expect(router.push).toHaveBeenCalledWith("/profile");
  });

  it("switches deal-breakers on, takes what is fine, holds the limit, and saves the set", async () => {
    const { puts } = fakeApi(answeredAll);
    await show(<DealBreakersScreen />);
    await waitFor(() => expect(screen.getByText("Deal-breakers")).toBeTruthy());
    await press(screen.getByLabelText("Deal-breaker: Smoking"));
    expect(screen.getByText("Pick at least one answer that is fine with you.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Save the deal-breakers" }).props.accessibilityState
        ?.disabled,
    ).toBe(true);
    await press(screen.getByRole("button", { name: "Never" }));
    await press(screen.getByRole("button", { name: "Quitting" }));
    await press(screen.getByLabelText("Also people who did not answer"));
    await press(screen.getByLabelText("Deal-breaker: Kids"));
    await press(screen.getByRole("button", { name: "No kids" }));
    checkA11y();
    // A third one: refused in words, and the switch stays off.
    await press(screen.getByLabelText("Deal-breaker: Relationship structure"));
    expect(screen.getByText("That is 2 already.")).toBeTruthy();
    expect(
      screen.getByLabelText("Deal-breaker: Relationship structure").props.accessibilityState
        ?.checked,
    ).toBe(false);
    await press(screen.getByRole("button", { name: "Save the deal-breakers" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    expect(puts).toEqual([
      [
        { field: "hasKids", accept: ["no"], includeUnknown: false },
        { field: "smoking", accept: ["never", "quitting"], includeUnknown: true },
      ],
    ]);
  });

  it("says in words that a deal-breaker is paused while the own answer is missing", async () => {
    fakeApi({ ...answeredAll, smoking: undefined }, [
      { field: "smoking", accept: ["never"], includeUnknown: false },
    ]);
    await show(<DealBreakersScreen />);
    await waitFor(() =>
      expect(screen.getByText("Paused until you answer it yourself.")).toBeTruthy(),
    );
    expect(screen.getByLabelText("Deal-breaker: Smoking").props.accessibilityState?.checked).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Never" }).props.accessibilityState?.selected).toBe(
      true,
    );
    await press(screen.getByRole("button", { name: "Answer it" }));
    expect(router.push).toHaveBeenCalledWith("/profile/later/smoking");
  });

  it("says when the deal-breakers could not be read, and tries again", async () => {
    globalThis.fetch = jest.fn(async () =>
      json({ error: { code: "x", message: "no", requestId: "r" } }, 500),
    ) as unknown as typeof fetch;
    await show(<DealBreakersScreen />);
    await waitFor(() =>
      expect(screen.getByText("Your profile could not be loaded. Try again.")).toBeTruthy(),
    );
    fakeApi(answeredAll);
    await press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Deal-breakers")).toBeTruthy());
  });
});
