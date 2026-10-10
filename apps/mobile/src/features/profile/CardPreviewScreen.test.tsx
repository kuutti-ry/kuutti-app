import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { PixelRatio } from "react-native";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { MAX_FONT_SCALE } from "@/theme/a11y";
import { CardPreviewScreen } from "./CardPreviewScreen";

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock };
};
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const PHOTO_A = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";
const PHOTO_B = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a02";

/** A full card as the API builds it for another viewer (#150): gender and identity label, shared answers marked. */
const card = {
  accountId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  displayName: "Aino",
  age: { years: 36, verifiedByBank: true },
  gender: "non_binary",
  pond: {
    id: "5f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a00",
    slug: "espoo",
    name: "Espoo",
    nameInessive: "Espoossa",
    parentId: null,
  },
  photos: [
    { id: PHOTO_A, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", width: 1200, height: 1600 },
    { id: PHOTO_B, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", width: 1200, height: 1600 },
  ],
  fields: {
    identityLabel: "genderfluid",
    languages: ["fi", "en"],
    intent: "long_term",
    hobbies: ["yoga", "hiking"],
    occupationTitle: "Architect",
    height: 171,
    politics: ["kok", "vihr"],
    zodiac: "corgi",
  },
  bio: null,
  bioPreset: "photos_speak",
  prompts: [
    { key: "sunday", answer: "A long breakfast." },
    { key: "hidden_talent", answer: "I can whistle with my mouth full." },
  ],
  shared: { hobbies: ["yoga"], languages: ["en"] },
};

/** Every text of the rendered tree, in reading order. */
const textsOf = (node: unknown): string[] => {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(textsOf);
  if (node && typeof node === "object" && "children" in node) {
    return textsOf((node as { children: unknown }).children);
  }
  return [];
};

function serveCard(completeness = { complete: false, missing: ["seeks", "age_window"] }) {
  const calls: string[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    calls.push(path);
    if (path === "/profile/card") return json({ card, completeness });
    if (path.startsWith("/photos/")) {
      const variant = path.split("/").pop();
      return json({
        url: `https://media.test/media/k/${variant}.webp?Signature=s`,
        variant,
        expiresAt: "2030-01-01T00:15:00.000Z",
      });
    }
    return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
  }) as unknown as typeof fetch;
  return calls;
}

const show = () =>
  act(async () => {
    renderWithTheme(<CardPreviewScreen />);
    await settle();
  });

beforeEach(async () => {
  router.back.mockReset();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("CardPreviewScreen", () => {
  it("shows the card as others see it: the verified age, the gender with its label, the photos through the photo route, the choices in words", async () => {
    const calls = serveCard();
    await show();
    await waitFor(() => expect(screen.getByText("Aino")).toBeTruthy());
    expect(screen.getByText("36, age verified by your bank")).toBeTruthy();
    expect(screen.getByText("Non-binary")).toBeTruthy();
    expect(screen.getByText("Genderfluid")).toBeTruthy();
    expect(screen.getByText("Espoo")).toBeTruthy();
    // Languages by their own names, the same in every catalogue (ADR-019 §3); what both answered said in words.
    expect(screen.getByText("suomi, English (you too)")).toBeTruthy();
    expect(screen.getByText("Yoga (you too), Hiking")).toBeTruthy();
    expect(screen.getByText("Something long-term")).toBeTruthy();
    expect(screen.getByText("Architect")).toBeTruthy();
    expect(screen.getByText("171 cm")).toBeTruthy();
    expect(screen.getByText("The photos say it. The rest over coffee.")).toBeTruthy();
    expect(screen.getByText("A long breakfast.")).toBeTruthy();
    expect(screen.getByText("I can whistle with my mouth full.")).toBeTruthy();
    expect(screen.getByText("Whom you are looking for (set in onboarding)")).toBeTruthy();
    // The identity label stands in the header, not among the fields.
    expect(screen.queryByText("Identity")).toBeNull();
    // The card leads with the photo and one answer in the person's words; the rest follows (#150).
    const order = textsOf(screen.toJSON());
    expect(order.indexOf("Non-binary")).toBeLessThan(order.indexOf("Genderfluid"));
    expect(order.indexOf("A long breakfast.")).toBeLessThan(order.indexOf("Hobbies"));
    expect(order.indexOf("Hobbies")).toBeLessThan(
      order.indexOf("I can whistle with my mouth full."),
    );
    await waitFor(() => expect(calls).toContain(`/photos/${PHOTO_A}/card`));
    expect(calls).toContain(`/photos/${PHOTO_B}/thumb`);
    expect(calls.filter((p) => p.endsWith("/full"))).toEqual([]);
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Back to your profile" }));
      await settle();
    });
    expect(router.back).toHaveBeenCalled();
  });

  it("holds at the largest font size with a full profile", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(MAX_FONT_SCALE);
    serveCard({ complete: true, missing: [] });
    await show();
    await waitFor(() => expect(screen.getByText("Aino")).toBeTruthy());
    expect(screen.getByText("Yoga (you too), Hiking")).toBeTruthy();
    expect(screen.getByText("I can whistle with my mouth full.")).toBeTruthy();
    // No fixed-height text container anywhere on the card (CLAUDE.md Accessibility).
    const fixed = (node: unknown): boolean => {
      if (Array.isArray(node)) return node.some(fixed);
      if (!node || typeof node !== "object") return false;
      const { type, props, children } = node as {
        type?: string;
        props?: { style?: unknown; numberOfLines?: number };
        children?: unknown;
      };
      if (type === "Text") {
        const style = ([] as unknown[]).concat(props?.style ?? []) as { height?: unknown }[];
        if (props?.numberOfLines !== undefined || style.some((s) => s?.height !== undefined)) {
          return true;
        }
      }
      return fixed(children);
    };
    expect(fixed(screen.toJSON())).toBe(false);
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  });

  it("asks for the profile first when there is no card yet", async () => {
    globalThis.fetch = jest.fn(async () =>
      json({ card: null, completeness: { complete: false, missing: ["display_name"] } }),
    ) as unknown as typeof fetch;
    await show();
    await waitFor(() => expect(screen.getByText(/Save your profile first/)).toBeTruthy());
  });
});
