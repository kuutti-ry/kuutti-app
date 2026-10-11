import type { ProfileCard } from "@kuutti/schema";
import { act, screen } from "@testing-library/react-native";
import { saveSession } from "@/lib/session";
import { renderWithTheme } from "@/test/render";
import { ProfileCardView } from "./ProfileCardView";

// A card as others see it (#47, #150): what it shows when the person has
// given little, what wins when they have given more, and a refused photo
// handed to the screen.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const PHOTO = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01" as ProfileCard["photos"][number]["id"];
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));

const bare: ProfileCard = {
  accountId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  displayName: "Aino",
  age: { years: 36, verifiedByBank: true },
  gender: null,
  pond: null,
  photos: [],
  fields: {},
  bio: null,
  bioPreset: null,
  prompts: [],
  shared: { hobbies: [], languages: [] },
};

/** Every text of the rendered tree, in reading order. */
const texts = (node: unknown): string[] => {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (node && typeof node === "object" && "children" in node) {
    return texts((node as { children: unknown }).children);
  }
  return [];
};

beforeEach(async () => {
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
  globalThis.fetch = jest.fn(async () =>
    json({ error: { code: "not_found", message: "x", requestId: "r" } }, 404),
  ) as unknown as typeof fetch;
});

describe("ProfileCardView", () => {
  it("shows the name as the title and the bank-verified age, and nothing the person did not give", async () => {
    await renderWithTheme(<ProfileCardView card={bare} />);
    expect(screen.getByRole("heading", { name: "Aino" })).toBeTruthy();
    expect(texts(screen.toJSON())).toEqual(["Aino", "36, age verified by your bank"]);
    expect(screen.queryByRole("image")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("shows the bio the person wrote rather than a placeholder", async () => {
    await renderWithTheme(
      <ProfileCardView card={{ ...bare, bio: "Long walks.", bioPreset: "photos_speak" }} />,
    );
    expect(screen.getByText("Long walks.")).toBeTruthy();
    expect(screen.queryByText("The photos say it. The rest over coffee.")).toBeNull();
  });

  it("says a number in its unit, a choice in words, and what both answered as such", async () => {
    await renderWithTheme(
      <ProfileCardView
        card={{
          ...bare,
          fields: { height: 171, intent: "casual", languages: ["fi", "en"] },
          shared: { hobbies: [], languages: ["fi"] },
        }}
      />,
    );
    expect(screen.getByText("171 cm")).toBeTruthy();
    expect(screen.getByText("Something casual")).toBeTruthy();
    expect(screen.getByText("suomi (you too), English")).toBeTruthy();
  });

  it("names the photos by position and hands a refused one to the screen", async () => {
    globalThis.fetch = jest.fn(async () =>
      json({ error: { code: "photo_budget_exceeded", message: "x", requestId: "r" } }, 429),
    ) as unknown as typeof fetch;
    const refused = jest.fn();
    await renderWithTheme(
      <ProfileCardView
        card={{
          ...bare,
          photos: [
            { id: PHOTO, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", width: 1200, height: 1600 },
          ],
        }}
        onRefused={refused}
      />,
    );
    await settle();
    expect(screen.getByLabelText("Photo 1 of 1")).toBeTruthy();
    expect(refused).toHaveBeenCalledWith("photo_budget_exceeded");
  });
});
