import type { ProfileCard } from "@kuutti/schema";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { Image } from "expo-image";
import * as SecureStore from "expo-secure-store";
import { AccessibilityInfo } from "react-native";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
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
/** A tap on the photo's right half: the next one comes to the front (#513). */
const next = () =>
  act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Next photo" }));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  });
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
    refreshToken: `${token("family")}.${token("refresh")}`,
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
    // The photo in front, its line under it: visible, hidden from the accessibility
    // tree, since the label carries it; the next one's comes with it.
    const lines = ["A summer day", null, "With a four-legged friend"];
    const labels = [
      "Photo 1 of 3. A summer day",
      "Photo 2 of 3",
      "Photo 3 of 3. With a four-legged friend",
    ];
    for (const [at, label] of labels.entries()) {
      if (at > 0) await next();
      expect(screen.getByLabelText(label)).toBeTruthy();
      for (const line of lines) {
        if (line === null) continue;
        const under = screen.queryByText(line, { includeHiddenElements: true });
        expect(under !== null).toBe(line === lines[at]);
        expect(screen.queryByText(line)).toBeNull();
      }
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
    await next();
    expect(screen.getByLabelText(`Photo 2 of 3. ${saunaWords}`)).toBeTruthy();
    await next();
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
    expect(screen.getByText(lakesideNoFace, { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByText(lakesideNoFace)).toBeNull();
    await next();
    expect(screen.getByLabelText(`Photo 2 of 3. ${saunaNoFace}`)).toBeTruthy();
    // Under the photo in front only.
    expect(screen.queryByText(lakesideNoFace, { includeHiddenElements: true })).toBeNull();
    expect(screen.getByText(saunaNoFace, { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByText(saunaNoFace)).toBeNull();
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

  it("offers the card's own photos in its report, named as the card names them and drawn from the phone's cache, signs nothing more, and reports the one chosen (#476)", async () => {
    const asked: string[] = [];
    const sent: unknown[] = [];
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      asked.push(path);
      if (request.method === "POST" && path === "/reports") {
        sent.push(JSON.parse(await request.text()));
        return new Response(null, { status: 204 });
      }
      return json({ error: { code: "not_found", message: "x", requestId: "r" } }, 404);
    }) as unknown as typeof fetch;
    const cache = jest.spyOn(Image, "readFromCacheAsync");
    const sauna = {
      people: 1,
      setting: "indoors" as const,
      scene: ["sauna" as const],
      objects: [],
      smile: false,
      glasses: false,
      sunglasses: false,
      facialHair: false,
    };
    const card = { ...bare, photos: [photoAt(1), photoAt(2, "summer_day", sauna)] };
    await renderWithTheme(<ProfileCardView card={card} onGone={jest.fn()} />);
    await settle();
    const signed = () => asked.filter((path) => path.startsWith("/photos/"));
    // The main photo's card variant, and the other's once it came to the front.
    expect(signed()).toEqual([`/photos/${photoAt(1).id}/card`]);
    await next();
    expect(signed()).toEqual([`/photos/${photoAt(1).id}/card`, `/photos/${photoAt(2).id}/card`]);
    const press = (name: string, role: "button" | "radio" = "button") =>
      act(async () => {
        fireEvent.press(screen.getByRole(role, { name }));
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      });
    await press("Block or report");
    await press("Report and block");
    const heard =
      "Photo 2 of 2. A summer day. Automatic description: One person, indoors, in a sauna.";
    expect(
      within(screen.getByLabelText("Is it about one photo?"))
        .getAllByRole("radio")
        .map((radio) => radio.props.accessibilityLabel),
    ).toEqual(["✓ Not one photo", "Photo 1 of 2", heard]);
    // Seen beside its picture: the place and the caption, as under the photo.
    expect(screen.getByText("Photo 2 of 2. A summer day")).toBeTruthy();
    // Under the keys the card painted them by, and no URL signed again.
    expect(cache.mock.calls).toEqual([[`${photoAt(1).id}/card`], [`${photoAt(2).id}/card`]]);
    expect(signed()).toHaveLength(2);
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
    await press(heard, "radio");
    await press("Something else", "radio");
    await press("Send report");
    await waitFor(() =>
      expect(sent).toEqual([
        { accountId: bare.accountId, reason: "other", photoId: photoAt(2).id },
      ]),
    );
    cache.mockRestore();
  });

  it("shows one photo at a time, the next and the previous by a tap on either half, asks for each once when it first comes to the front, and says which came (#513)", async () => {
    const asked: string[] = [];
    globalThis.fetch = jest.fn(async (input: Request | string) => {
      asked.push(new URL(input instanceof Request ? input.url : input).pathname);
      return json({ error: { code: "not_found", message: "x", requestId: "r" } }, 404);
    }) as unknown as typeof fetch;
    const said = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
    said.mockClear();
    const card = { ...bare, photos: [photoAt(1), photoAt(2, "summer_day"), photoAt(3)] };
    await renderWithTheme(<ProfileCardView card={card} onGone={jest.fn()} />);
    await settle();
    const button = (name: string) => screen.getByRole("button", { name });
    const dimmed = (name: string) => button(name).props.accessibilityState?.disabled === true;
    // One photo heard at a time; nothing beyond it asked for (prefetch counts as exposure).
    expect(screen.getAllByRole("image").map((image) => image.props.accessibilityLabel)).toEqual([
      "Photo 1 of 3",
    ]);
    expect(asked).toEqual([`/photos/${photoAt(1).id}/card`]);
    expect([dimmed("Previous photo"), dimmed("Next photo")]).toEqual([true, false]);
    await fireEvent.press(button("Previous photo"));
    expect(said).not.toHaveBeenCalled();

    await next();
    expect(screen.getAllByRole("image").map((image) => image.props.accessibilityLabel)).toEqual([
      "Photo 2 of 3. A summer day",
    ]);
    expect(said).toHaveBeenLastCalledWith("Photo 2 of 3. A summer day");
    expect([dimmed("Previous photo"), dimmed("Next photo")]).toEqual([false, false]);
    await act(async () => {
      fireEvent.press(button("Previous photo"));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    expect(said).toHaveBeenLastCalledWith("Photo 1 of 3");
    await next();
    await next();
    expect(said).toHaveBeenLastCalledWith("Photo 3 of 3");
    expect([dimmed("Previous photo"), dimmed("Next photo")]).toEqual([false, true]);
    await fireEvent.press(button("Next photo"));
    expect(screen.getByLabelText("Photo 3 of 3")).toBeTruthy();
    // Each signed once, in the card size, however often it came back to the front.
    expect(asked).toEqual([1, 2, 3].map((n) => `/photos/${photoAt(n).id}/card`));
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
    said.mockRestore();
  });

  it("has no Previous or Next on a card with one photo (#513)", async () => {
    await renderWithTheme(<ProfileCardView card={{ ...bare, photos: [photoAt(1)] }} />);
    await settle();
    expect(screen.getByLabelText("Photo 1 of 1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Previous photo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next photo" })).toBeNull();
  });

  it("starts the next person's card at their main photo (#513)", async () => {
    const first = { ...bare, photos: [photoAt(1), photoAt(2)] };
    await renderWithTheme(<ProfileCardView card={first} />);
    await settle();
    await next();
    expect(screen.getByLabelText("Photo 2 of 2")).toBeTruthy();
    const second = {
      ...bare,
      accountId: "7a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
      photos: [photoAt(3), photoAt(4)],
    };
    await screen.rerender(underProviders(<ProfileCardView card={second} />));
    await settle();
    expect(screen.getAllByRole("image").map((image) => image.props.accessibilityLabel)).toEqual([
      "Photo 1 of 2",
    ]);
    expect(
      screen.getByRole("button", { name: "Previous photo" }).props.accessibilityState,
    ).toMatchObject({ disabled: true });
  });
});
