import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import type * as React from "react";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { LaterFieldScreen, laterProgress } from "./LaterFieldScreen";

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock };
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
const type = (element: ReturnType<typeof screen.getByLabelText>, text: string) =>
  act(async () => {
    fireEvent.changeText(element, text);
    await settle();
  });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const SPECIAL = "2026-10-draft-2";

type Profile = {
  displayName: string;
  bio: string | null;
  bioPreset: string | null;
  fields: Record<string, unknown>;
  prompts: { key: string; answer: string }[];
  specialCategoryConsent: { version: string } | null;
};

/** A tiny server for the profile: the later screens read it, "Save and continue" writes it whole. */
function fakeApi(profile: Profile | null = null) {
  const server = { profile };
  const puts: Profile[] = [];
  const response = () => ({
    profile: server.profile
      ? {
          ...server.profile,
          specialCategoryConsent: server.profile.specialCategoryConsent
            ? { ...server.profile.specialCategoryConsent, at: "2026-10-08T10:00:00.000Z" }
            : null,
          updatedAt: "2026-10-08T10:00:00.000Z",
        }
      : null,
    completeness: { complete: false, missing: ["photos"] },
  });
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/profile" && request.method === "GET") return json(response());
    if (path === "/profile" && request.method === "PUT") {
      const body = (await request.json()) as Profile;
      puts.push(body);
      server.profile = body;
      return json(response());
    }
    return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
  }) as unknown as typeof fetch;
  return { server, puts };
}

const named = (fields: Record<string, unknown>, consent: string | null = null): Profile => ({
  displayName: "Aino",
  bio: null,
  bioPreset: null,
  fields,
  prompts: [],
  specialCategoryConsent: consent ? { version: consent } : null,
});

const checkA11y = () => {
  const found = pressables(screen.toJSON() as HostNode);
  expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
};

beforeEach(async () => {
  router.push.mockReset();
  router.replace.mockReset();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("LaterFieldScreen", () => {
  it("asks the first field with the progress, skips without writing, and saves before moving on", async () => {
    const { puts } = fakeApi(named({}));
    await show(<LaterFieldScreen field="hasKids" />);
    await waitFor(() => expect(screen.getByText("While you wait")).toBeTruthy());
    expect(screen.getByText("0 of 16 answered")).toBeTruthy();
    expect(screen.getByText(/One question at a time/)).toBeTruthy();
    expect(screen.getByText("No kids")).toBeTruthy();
    checkA11y();
    await press(screen.getByRole("button", { name: "Ask me later" }));
    expect(router.push).toHaveBeenCalledWith("/profile/later/wantsKids");
    expect(puts).toEqual([]);
    await press(screen.getByRole("button", { name: "Yes, living with me" }));
    await press(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ displayName: "Aino", fields: { hasKids: "yes_with_me" } });
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(2));
    expect(screen.getByText("1 of 16 answered")).toBeTruthy();
  });

  it("lands on the first unanswered field when the first one is answered already", async () => {
    fakeApi(named({ hasKids: "no" }));
    await show(<LaterFieldScreen field="hasKids" />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/profile/later/wantsKids"));
  });

  it("moves on past answered fields, to the next one without an answer", async () => {
    fakeApi(named({ wantsKids: "want", smoking: "never" }));
    await show(<LaterFieldScreen field="hasKids" />);
    await waitFor(() => expect(screen.getByText("2 of 16 answered")).toBeTruthy());
    expect(router.replace).not.toHaveBeenCalled();
    await press(screen.getByRole("button", { name: "Ask me later" }));
    expect(router.push).toHaveBeenCalledWith("/profile/later/languages");
  });

  it("keeps the intro line on the first unanswered field while it is being answered", async () => {
    fakeApi(named({ hasKids: "no" }));
    await show(<LaterFieldScreen field="wantsKids" />);
    await waitFor(() => expect(screen.getByText(/One question at a time/)).toBeTruthy());
    await press(screen.getByRole("button", { name: "Want kids" }));
    expect(screen.getByText(/One question at a time/)).toBeTruthy();
  });

  it("adapts the wants-kids texts to the kids answer", async () => {
    fakeApi(named({ hasKids: "yes_with_me" }));
    await show(<LaterFieldScreen field="wantsKids" />);
    await waitFor(() => expect(screen.getByText("Want more")).toBeTruthy());
    expect(screen.getByText("No more")).toBeTruthy();
    expect(screen.getByText("Not sure anymore")).toBeTruthy();
    expect(screen.queryByText("Want kids")).toBeNull();
    expect(laterProgress({ hasKids: "yes_with_me" })).toEqual({ answered: 1, total: 16 });
  });

  it("offers an article 9 field behind its consent and saves the wording's version with the answer", async () => {
    const { puts } = fakeApi(named({}));
    await show(<LaterFieldScreen field="politics" />);
    await waitFor(() => expect(screen.getByText("Sensitive answers")).toBeTruthy());
    expect(screen.queryByText("Greens")).toBeNull();
    await press(screen.getByLabelText("Sensitive answers"));
    await waitFor(() => expect(screen.getByText("Greens")).toBeTruthy());
    checkA11y();
    await press(screen.getByRole("button", { name: "Greens" }));
    await press(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({
      fields: { politics: ["vihr"] },
      specialCategoryConsent: { version: SPECIAL },
    });
    expect(router.push).toHaveBeenCalledWith("/profile/later/religion");
  });

  it("searches a long list, and shows the hobbies in their groups", async () => {
    fakeApi(named({}));
    await show(<LaterFieldScreen field="languages" />);
    await waitFor(() => expect(screen.getByText("suomi")).toBeTruthy());
    expect(screen.getByText("English")).toBeTruthy();
    await type(screen.getByLabelText("Search"), "suo");
    expect(screen.getByText("suomi")).toBeTruthy();
    expect(screen.queryByText("English")).toBeNull();
  });

  it("groups the hobbies and keeps the companion of a field on its screen", async () => {
    fakeApi(named({}));
    await show(<LaterFieldScreen field="hobbies" />);
    await waitFor(() => expect(screen.getByText("Outdoors")).toBeTruthy());
    expect(screen.getByText("Hiking")).toBeTruthy();
    expect(screen.getByText("Something else")).toBeTruthy();
    const { unmount } = await act(async () => {
      const rendered = renderWithTheme(<LaterFieldScreen field="field" />);
      await settle();
      return rendered;
    });
    await waitFor(() => expect(screen.getByText("Hide me from people in my field")).toBeTruthy());
    unmount();
  });

  it("steps a number from the middle of its range, and clears it again", async () => {
    const { puts } = fakeApi(named({}));
    await show(<LaterFieldScreen field="height" />);
    await waitFor(() => expect(screen.getByText("No answer yet")).toBeTruthy());
    checkA11y();
    await press(screen.getByRole("button", { name: "One more" }));
    expect(screen.getByText("180\u00a0cm")).toBeTruthy();
    await press(screen.getByRole("button", { name: "One more" }));
    expect(screen.getByText("181\u00a0cm")).toBeTruthy();
    await press(screen.getByRole("button", { name: "One less" }));
    expect(screen.getByText("180\u00a0cm")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.fields).toEqual({ height: 180 });
    await press(screen.getByRole("button", { name: "Clear the answer" }));
    expect(screen.getByText("No answer yet")).toBeTruthy();
  });

  it("leads from the last field to the e-mail, and from an unknown one to the first", async () => {
    fakeApi(named({}));
    await show(<LaterFieldScreen field="zodiac" />);
    await waitFor(() => expect(screen.getByText("Corgi")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Ask me later" }));
    expect(router.push).toHaveBeenCalledWith("/account/email");
    const { unmount } = await act(async () => {
      const rendered = renderWithTheme(<LaterFieldScreen field="nope" />);
      await settle();
      return rendered;
    });
    expect(router.replace).toHaveBeenCalledWith("/profile/later/hasKids");
    unmount();
  });
});
