import type { ProfileCard } from "@kuutti/schema";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { ProfileCardView } from "./ProfileCardView";

// A card as others see it (#47, #150): what it shows when the person has
// given little, what wins when they have given more, and a refused photo
// handed to the screen.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const PHOTO = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01" as ProfileCard["photos"][number]["id"];
const photoAt = (
  n: number,
  caption: ProfileCard["photos"][number]["caption"] = null,
  description: ProfileCard["photos"][number]["description"] = null,
) => ({
  id: `0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a0${n}` as ProfileCard["photos"][number]["id"],
  blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
  width: 1200,
  height: 1600,
  caption,
  description,
});
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;

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
  store.delete("kuutti.preference.photoDescriptions");
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
  it("shows the name with the age as the title, and nothing the person did not give", async () => {
    await renderWithTheme(<ProfileCardView card={bare} />);
    // The age as visible as the name, and no word on the bank: every account is verified (#239).
    expect(screen.getByRole("heading", { name: "Aino, 36" })).toBeTruthy();
    expect(texts(screen.toJSON())).toEqual(["Aino, 36"]);
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
    expect(screen.getByText("Finnish (you too), English")).toBeTruthy();
  });

  it("says a dance partner as what the person is looking for (#175)", async () => {
    await renderWithTheme(
      <ProfileCardView card={{ ...bare, fields: { intent: "dance_partner" } }} />,
    );
    expect(texts(screen.toJSON())).toEqual(["Aino, 36", "Looking for", "A dance partner"]);
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
            {
              id: PHOTO,
              blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
              width: 1200,
              height: 1600,
              caption: null,
              description: null,
            },
          ],
        }}
        onRefused={refused}
      />,
    );
    await settle();
    expect(screen.getByLabelText("Photo 1 of 1")).toBeTruthy();
    expect(refused).toHaveBeenCalledWith("photo_budget_exceeded");
  });

  it("shows the owner's caption under a photo for the eye, and says it once, with the photo, to a screen reader (#296)", async () => {
    await renderWithTheme(
      <ProfileCardView
        card={{
          ...bare,
          photos: [photoAt(1, "summer_day"), photoAt(2), photoAt(3, "four_legged")],
        }}
      />,
    );
    await settle();
    expect(screen.getByLabelText("Photo 1 of 3. A summer day")).toBeTruthy();
    expect(screen.getByLabelText("Photo 2 of 3")).toBeTruthy();
    expect(screen.getByLabelText("Photo 3 of 3. With a four-legged friend")).toBeTruthy();
    // Visible under the photo, hidden from the accessibility tree: the label above carries it.
    for (const line of ["A summer day", "With a four-legged friend"]) {
      expect(screen.getByText(line, { includeHiddenElements: true })).toBeTruthy();
      expect(screen.queryByText(line)).toBeNull();
    }
  });

  it("reads the check's description after the caption on every photo, and shows it under the photo when the setting asks (#296)", async () => {
    const lakeside = {
      people: 1,
      setting: "outdoors" as const,
      scene: ["lake" as const],
      objects: ["hiking" as const, "dog" as const],
      smile: true,
      glasses: false,
      sunglasses: true,
      facialHair: false,
    };
    const sauna = {
      ...lakeside,
      setting: "indoors" as const,
      scene: ["sauna" as const],
      objects: [],
    };
    const card = {
      ...bare,
      photos: [photoAt(1, "summer_day", lakeside), photoAt(2, null, sauna), photoAt(3)],
    };
    const lakesideWords =
      "Automatic description: One person, outdoors, by a lake. Smiling, sunglasses. Hiking, with a dog.";
    const saunaWords =
      "Automatic description: One person, indoors, in a sauna. Smiling, sunglasses.";
    await renderWithTheme(<ProfileCardView card={card} />);
    await settle();
    // The caption first, then the machine's words, named as such; a photo without a description says nothing more.
    expect(screen.getByLabelText(`Photo 1 of 3. A summer day. ${lakesideWords}`)).toBeTruthy();
    expect(screen.getByLabelText(`Photo 2 of 3. ${saunaWords}`)).toBeTruthy();
    expect(screen.getByLabelText("Photo 3 of 3")).toBeTruthy();
    expect(screen.queryByText(lakesideWords, { includeHiddenElements: true })).toBeNull();

    // Shown under the photos, hidden from the accessibility tree, with the face left out everywhere.
    store.set(
      "kuutti.preference.photoDescriptions",
      JSON.stringify({ shown: true, people: true, face: false, objects: true }),
    );
    await renderWithTheme(<ProfileCardView card={card} />);
    await settle();
    const lakesideNoFace =
      "Automatic description: One person, outdoors, by a lake. Hiking, with a dog.";
    const saunaNoFace = "Automatic description: One person, indoors, in a sauna.";
    expect(
      await screen.findByLabelText(`Photo 1 of 3. A summer day. ${lakesideNoFace}`),
    ).toBeTruthy();
    expect(screen.getByLabelText(`Photo 2 of 3. ${saunaNoFace}`)).toBeTruthy();
    for (const words of [lakesideNoFace, saunaNoFace]) {
      expect(screen.getByText(words, { includeHiddenElements: true })).toBeTruthy();
      expect(screen.queryByText(words)).toBeNull();
    }
  });
  it("has no block or report on the owner's own card", async () => {
    await renderWithTheme(<ProfileCardView card={bare} />);
    expect(screen.queryByRole("button", { name: "Block or report" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Aino, 36" }).props.accessibilityActions).toBe(
      undefined,
    );
  });

  it("offers block or report on someone else's card, as a button beside the name and as an action on it, and hands the card back after a block (#84)", async () => {
    globalThis.fetch = jest.fn(async (input: Request | string) => {
      const request = input instanceof Request ? input : new Request(input);
      return new URL(request.url).pathname === "/blocks"
        ? new Response(null, { status: 204 })
        : json({ error: { code: "not_found", message: "x", requestId: "r" } }, 404);
    }) as unknown as typeof fetch;
    const gone = jest.fn();
    await renderWithTheme(<ProfileCardView card={bare} onGone={gone} />);
    expect(screen.getByRole("button", { name: "Block or report" })).toBeTruthy();
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
    const name = screen.getByRole("heading", { name: "Aino, 36" });
    expect(name.props.accessibilityActions).toEqual([
      { name: "blockOrReport", label: "Block or report" },
    ]);
    // Another action reaching the name opens nothing.
    await act(async () => {
      fireEvent(name, "accessibilityAction", { nativeEvent: { actionName: "activate" } });
    });
    expect(screen.queryByRole("button", { name: "Report and block" })).toBeNull();
    await act(async () => {
      fireEvent(name, "accessibilityAction", { nativeEvent: { actionName: "blockOrReport" } });
    });
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Block" }));
    });
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Block" }));
    });
    await screen.findByText("Blocked. You will not see each other again.");
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Done" }));
    });
    await waitFor(() => expect(gone).toHaveBeenCalledWith(bare.accountId));
  });
});
