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
// Every event in its own act scope, settled before the next query: a state
// update dispatched outside one is not flushed by a later act in this runtime.
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

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const missing = ["display_name", "photos", "bio_or_prompts", "seeks", "age_window"];

function fakeApi(options: { saveStatus?: number; saveCode?: string } = {}) {
  const puts: unknown[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/profile" && request.method === "GET") {
      return json({
        profile: null,
        completeness: { complete: false, missing },
        tips: { tip: "fewer_photos" },
      });
    }
    if (path === "/profile" && request.method === "PUT") {
      const body = await request.json();
      puts.push(body);
      if (options.saveStatus) {
        return json(
          {
            error: { code: options.saveCode ?? "validation_failed", message: "no", requestId: "r" },
          },
          options.saveStatus,
        );
      }
      return json({
        profile: {
          ...(body as object),
          specialCategoryConsent: null,
          updatedAt: "2026-09-26T10:00:00.000Z",
        },
        completeness: { complete: false, missing: ["photos", "seeks", "age_window"] },
        tips: { tip: "fewer_photos" },
      });
    }
    return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
  }) as unknown as typeof fetch;
  return { puts };
}

beforeEach(async () => {
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("ProfileScreen", () => {
  it("renders every field, option, prompt and placeholder of the registry with a text, and every control labelled", async () => {
    fakeApi();
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText("Languages")).toBeTruthy());
    expect(screen.getByText("Something long-term")).toBeTruthy();
    expect(screen.getByText("My ideal Sunday")).toBeTruthy();
    expect(screen.getByText(/too lazy to write/)).toBeTruthy();
    expect(screen.getByText("At least 3 approved photos")).toBeTruthy();
    // A text that is still its key means the catalogue and the registry disagree.
    expect(screen.queryAllByText(/^profile\./)).toEqual([]);
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.length).toBeGreaterThan(60);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  });

  it("saves the document: the name, a choice, two languages and an answered prompt", async () => {
    const { puts } = fakeApi();
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByLabelText("Name on your card")).toBeTruthy());
    await type(screen.getByLabelText("Name on your card"), "Aino");
    await press(screen.getByRole("button", { name: "Something long-term" }));
    await press(screen.getByRole("button", { name: "Finnish" }));
    await press(screen.getByRole("button", { name: "English" }));
    await press(screen.getByRole("button", { name: "My ideal Sunday" }));
    await type(screen.getByLabelText("Your answer to: My ideal Sunday"), "A long breakfast.");
    await press(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({
      displayName: "Aino",
      bio: null,
      bioPreset: null,
      fields: { intent: "long_term", languages: ["fi", "en"] },
      prompts: [{ key: "sunday", answer: "A long breakfast." }],
      specialCategoryConsent: null,
    });
    expect(screen.getByText("Saved.")).toBeTruthy();
    expect(screen.queryByText("A name on the card")).toBeNull();
  });

  it("says why a save was refused, in words", async () => {
    fakeApi({ saveStatus: 400, saveCode: "text_contact_details" });
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByLabelText("Name on your card")).toBeTruthy());
    await type(screen.getByLabelText("Name on your card"), "aino@example.com");
    await press(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText(/e-mail address, a link/)).toBeTruthy());
  });
});
