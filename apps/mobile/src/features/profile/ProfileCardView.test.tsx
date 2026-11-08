import { DISTANCE_BANDS, type ProfileCard } from "@kuutti/schema";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { Image } from "expo-image";
import { useLocales } from "expo-localization";
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
  place: null,
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

  describe("the place and how far (#514, ADR-061)", () => {
    const place = { fi: "Kallio", sv: "Berghäll" };

    it("says the gender, the label, the place and the band on one line under the name, apart by a drawn dot, before the words (#644)", async () => {
      await renderWithTheme(
        <ProfileCardView
          card={{
            ...bare,
            gender: "non_binary",
            fields: { identityLabel: "genderfluid" },
            place,
            bio: "Long walks.",
          }}
          distance="close"
        />,
      );
      expect(texts(screen.toJSON())).toEqual([
        "Aino, 36",
        "Non-binary",
        "Genderfluid",
        "Kallio",
        "Close",
        "Long walks.",
      ]);
      // One line, each word a text of its own and heard on its own; the dots are no text.
      const line = screen.getByTestId("card-line");
      for (const word of ["Non-binary", "Genderfluid", "Kallio", "Close"]) {
        expect(within(line).getByText(word)).toBeTruthy();
      }
      expect(within(line).queryByText("Long walks.")).toBeNull();
      expect(screen.queryAllByTestId("card-line-dot")).toEqual([]);
      expect(screen.getAllByTestId("card-line-dot", { includeHiddenElements: true })).toHaveLength(
        3,
      );
    });

    it("draws no dot beside a word alone (#644)", async () => {
      await renderWithTheme(<ProfileCardView card={{ ...bare, place }} />);
      expect(within(screen.getByTestId("card-line")).getByText("Kallio")).toBeTruthy();
      expect(
        screen.queryAllByTestId("card-line-dot", { includeHiddenElements: true }),
      ).toHaveLength(0);
    });

    it("has no line at all when there is nothing to say on it", async () => {
      await renderWithTheme(<ProfileCardView card={bare} />);
      expect(screen.queryByTestId("card-line")).toBeNull();
    });

    it.each([
      ["en-US", ["Nearby", "Close", "Around", "Far"]],
      ["fi-FI", ["Lähellä", "Melko lähellä", "Samoilla seuduilla", "Kauempana"]],
      ["sv-FI", ["I närheten", "Ganska nära", "I trakten", "Längre bort"]],
    ])("says each band in words, for a %s reader", async (tag, words) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
      try {
        for (const [at, band] of DISTANCE_BANDS.entries()) {
          await renderWithTheme(<ProfileCardView card={bare} distance={band} />);
          expect(screen.getByText(words[at] as string)).toBeTruthy();
        }
      } finally {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
      }
    });

    it.each([
      ["no band on a card from outside a round", undefined],
      ["no band on an entry from before distance", null],
    ])("says %s", async (_what, distance) => {
      await renderWithTheme(<ProfileCardView card={{ ...bare, place }} distance={distance} />);
      expect(texts(screen.toJSON())).toEqual(["Aino, 36", "Kallio"]);
    });

    it("says no place for somebody without a home, and a band all the same", async () => {
      await renderWithTheme(<ProfileCardView card={bare} distance="far" />);
      expect(texts(screen.toJSON())).toEqual(["Aino, 36", "Far"]);
    });

    it.each([
      ["en-US", "Kallio"],
      ["fi-FI", "Kallio"],
      ["sv-FI", "Berghäll"],
    ])("reads the place as the list has it, for a %s reader", async (tag, name) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
      try {
        await renderWithTheme(<ProfileCardView card={{ ...bare, place }} />);
        expect(screen.getByText(name)).toBeTruthy();
      } finally {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
      }
    });

    it("says it in words alone: no digits, no kilometres, no colour of its own", async () => {
      await renderWithTheme(<ProfileCardView card={{ ...bare, place }} distance="nearby" />);
      for (const line of texts(screen.toJSON())) {
        expect(line).not.toMatch(/\d{5}|\bkm\b/);
      }
      // The muted line of every fact on the card, like the gender's: the word is the meaning.
      expect(screen.getByText("Nearby").props.className).toBe(
        screen.getByText("Kallio").props.className,
      );
    });
  });

  it("shows the bio the person wrote rather than a placeholder", async () => {
    await renderWithTheme(
      <ProfileCardView card={{ ...bare, bio: "Long walks.", bioPreset: "photos_speak" }} />,
    );
    expect(screen.getByText("Long walks.")).toBeTruthy();
    expect(screen.queryByText("The photos say it. The rest over coffee.")).toBeNull();
  });

  it("says a number in its unit, a choice in words, and each of several answers as a chip of its own", async () => {
    await renderWithTheme(
      <ProfileCardView
        card={{ ...bare, fields: { height: 171, intent: "casual", languages: ["fi", "en"] } }}
      />,
    );
    expect(screen.getByText("171 cm")).toBeTruthy();
    expect(screen.getByText("Something casual")).toBeTruthy();
    expect(screen.getByText("Finnish")).toBeTruthy();
    expect(screen.getByText("English")).toBeTruthy();
  });

  it("says a dance partner as what the person is looking for (#175)", async () => {
    await renderWithTheme(
      <ProfileCardView card={{ ...bare, fields: { intent: "dance_partner" } }} />,
    );
    // The question is heard, not drawn: the compass says it to the eye (#644).
    expect(texts(screen.toJSON())).toEqual(["Aino, 36", "A dance partner"]);
    expect(screen.getByLabelText("Looking for: A dance partner")).toBeTruthy();
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
    await screen.findByText("Blocked.");
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

  describe("a short card and the whole card (#644)", () => {
    /** What each chip says to a screen reader, in reading order. */
    const heardChips = () =>
      screen.queryAllByTestId(/^chip-/).map((chip) => chip.props.accessibilityLabel as string);
    const toggle = (name: string) =>
      act(async () => {
        fireEvent.press(screen.getByRole("button", { name }));
      });
    const sunday: ProfileCard["prompts"][number] = { key: "sunday", answer: "A long breakfast." };
    const prompts: ProfileCard["prompts"] = [
      sunday,
      { key: "hidden_talent", answer: "I can whistle with my mouth full." },
    ];
    const full: ProfileCard = {
      ...bare,
      fields: {
        intent: "long_term",
        smoking: "never",
        exercise: "weekly",
        hobbies: ["yoga", "hiking"],
        politics: ["kesk"],
        religion: "non_religious",
        occupationTitle: "Architect",
      },
      bio: "Long walks.",
      prompts,
    };

    it("shows the key facts as chips in the person's own words, in the registry's order, each field's first chip heard with its question", async () => {
      await renderWithTheme(
        <ProfileCardView
          card={{
            ...bare,
            fields: {
              height: 171,
              languages: ["fi", "en"],
              smoking: "never",
              wantsKids: "want",
              hasKids: "no",
              monogamy: "monogamous",
              intent: "long_term",
              exercise: "weekly",
            },
          }}
        />,
      );
      expect(heardChips()).toEqual([
        "Looking for: Something long-term",
        "Relationship structure: Monogamous",
        "Kids: No kids",
        "Kids in the future: Want kids",
        "Smoking: Never",
        "Languages: Finnish",
        "English",
        "Height: 171 cm",
      ]);
      // The eye reads the answer after its icon, and no label line: a cigarette before "Never".
      expect(screen.getByText("Never")).toBeTruthy();
      expect(screen.queryByText("Smoking")).toBeNull();
      expect(
        within(screen.getByTestId("chip-smoking.never")).getByTestId("field-icon-smoking", {
          includeHiddenElements: true,
        }),
      ).toBeTruthy();
      // Exercise is no key fact: it waits for the whole card.
      expect(screen.queryByText("Weekly")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Show the whole card" }).props.accessibilityState,
      ).toMatchObject({ expanded: false });
    });

    it("leads with the first prompt and opens the rest in place under the same top, then closes it again", async () => {
      await renderWithTheme(<ProfileCardView card={full} />);
      expect(texts(screen.toJSON())).toEqual([
        "Aino, 36",
        "Something long-term",
        "Never",
        "My ideal Sunday",
        "A long breakfast.",
        "Show the whole card",
      ]);

      await toggle("Show the whole card");
      expect(texts(screen.toJSON())).toEqual([
        "Aino, 36",
        "Something long-term",
        "Never",
        "My ideal Sunday",
        "A long breakfast.",
        "Show less",
        "Long walks.",
        "My hidden talent",
        "I can whistle with my mouth full.",
        "Work and education",
        "Architect",
        "Lifestyle",
        "Weekly",
        "Hobbies",
        "Yoga",
        "Hiking",
        "Beliefs",
        "Centre Party",
        "Non-religious",
      ]);
      // The profile's own section titles, as headings, each answer heard with its question.
      for (const title of ["Work and education", "Lifestyle", "Hobbies", "Beliefs"]) {
        expect(screen.getByRole("heading", { name: title })).toBeTruthy();
      }
      expect(heardChips()).toEqual([
        "Looking for: Something long-term",
        "Smoking: Never",
        "Job title: Architect",
        "Exercise: Weekly",
        "Hobbies: Yoga",
        "Hiking",
        "Parties you could vote for: Centre Party",
        "Religion: Non-religious",
      ]);
      // A hobby carries its group's icon, a party its own mark, a religion without one the field's.
      expect(
        within(screen.getByTestId("chip-hobbies.hiking")).getByTestId("hobby-group-icon-outdoors", {
          includeHiddenElements: true,
        }),
      ).toBeTruthy();
      expect(
        within(screen.getByTestId("chip-hobbies.yoga")).getByTestId("hobby-group-icon-sports", {
          includeHiddenElements: true,
        }),
      ).toBeTruthy();
      expect(
        within(screen.getByTestId("chip-politics.kesk")).queryByTestId("field-icon-politics", {
          includeHiddenElements: true,
        }),
      ).toBeNull();
      expect(
        within(screen.getByTestId("chip-religion.non_religious")).getByTestId(
          "field-icon-religion",
          { includeHiddenElements: true },
        ),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Show less" }).props.accessibilityState,
      ).toMatchObject({ expanded: true });
      expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
        [],
      );

      await toggle("Show less");
      expect(screen.queryByText("Long walks.")).toBeNull();
      expect(screen.queryByText("Lifestyle")).toBeNull();
      expect(screen.getByRole("button", { name: "Show the whole card" })).toBeTruthy();
    });

    it("gives the short card the bio when there is no prompt, or the ready line when there is no bio, with nothing left to open", async () => {
      await renderWithTheme(<ProfileCardView card={{ ...bare, bio: "Long walks." }} />);
      expect(texts(screen.toJSON())).toEqual(["Aino, 36", "Long walks."]);
      await renderWithTheme(<ProfileCardView card={{ ...bare, bioPreset: "photos_speak" }} />);
      expect(texts(screen.toJSON())).toEqual([
        "Aino, 36",
        "The photos say it. The rest over coffee.",
      ]);
      expect(screen.queryByRole("button", { name: "Show the whole card" })).toBeNull();
    });

    it("keeps the ready line for the whole card when a prompt leads", async () => {
      await renderWithTheme(
        <ProfileCardView card={{ ...bare, bioPreset: "photos_speak", prompts: [sunday] }} />,
      );
      expect(screen.queryByText("The photos say it. The rest over coffee.")).toBeNull();
      await toggle("Show the whole card");
      expect(texts(screen.toJSON())).toEqual([
        "Aino, 36",
        "My ideal Sunday",
        "A long breakfast.",
        "Show less",
        "The photos say it. The rest over coffee.",
      ]);
    });

    it("has no Show the whole card while the short card holds everything", async () => {
      await renderWithTheme(
        <ProfileCardView
          card={{ ...bare, fields: { intent: "casual", height: 171 }, prompts: [sunday] }}
        />,
      );
      expect(screen.getByText("A long breakfast.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Show the whole card" })).toBeNull();
    });

    it("opens a whole card that holds only another prompt", async () => {
      await renderWithTheme(<ProfileCardView card={{ ...bare, prompts }} />);
      expect(screen.queryByText("I can whistle with my mouth full.")).toBeNull();
      await toggle("Show the whole card");
      expect(screen.getByText("I can whistle with my mouth full.")).toBeTruthy();
    });

    it("starts the next person's card short", async () => {
      await renderWithTheme(<ProfileCardView card={full} />);
      await toggle("Show the whole card");
      expect(screen.getByText("Long walks.")).toBeTruthy();
      const next = { ...full, accountId: "7a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b" };
      await screen.rerender(underProviders(<ProfileCardView card={next} />));
      expect(screen.queryByText("Long walks.")).toBeNull();
      expect(screen.getByRole("button", { name: "Show the whole card" })).toBeTruthy();
    });

    it("draws a field and a work that read the same as one chip with both icons, heard as both, and keeps a pair that differs apart", async () => {
      await renderWithTheme(
        <ProfileCardView
          card={{
            ...bare,
            fields: {
              field: ["arts", "science"],
              occupation: ["science", "arts_culture"],
              occupationTitle: "Architect",
            },
          }}
        />,
      );
      await toggle("Show the whole card");
      // Science and Science and research read apart, so each keeps its chip and its question.
      expect(heardChips()).toEqual([
        "Field and work: Arts and culture",
        "Field: Science",
        "Work: Science and research",
        "Job title: Architect",
      ]);
      expect(screen.getAllByText("Arts and culture")).toHaveLength(1);
      const both = screen.getByTestId("chip-field.arts");
      for (const icon of ["field-icon-field", "field-icon-occupation"]) {
        expect(within(both).getByTestId(icon, { includeHiddenElements: true })).toBeTruthy();
      }
    });

    it.each([
      ["en-US", "Field and work: Arts and culture"],
      ["fi-FI", "Ala ja työ: Taide ja kulttuuri"],
      ["sv-FI", "Bransch och arbete: Konst och kultur"],
    ])("says a field that reads as the work as both, for a %s reader", async (tag, heard) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
      try {
        await renderWithTheme(
          <ProfileCardView
            card={{ ...bare, fields: { field: ["arts"], occupation: ["arts_culture"] } }}
          />,
        );
        await act(async () => {
          fireEvent.press(screen.getByRole("button"));
        });
        expect(heardChips()).toEqual([heard]);
      } finally {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
      }
    });

    it("marks an answer both gave by a filled chip in bold, heard as shared, in the order given, and never says 'you too'", async () => {
      await renderWithTheme(
        <ProfileCardView
          card={{
            ...bare,
            fields: { languages: ["fi", "en"], hobbies: ["yoga", "hiking"] },
            shared: { languages: ["fi"], hobbies: ["hiking"] },
          }}
        />,
      );
      await toggle("Show the whole card");
      expect(heardChips()).toEqual([
        "Languages: Finnish, shared",
        "English",
        "Hobbies: Yoga",
        "Hiking, shared",
      ]);
      // Every chip keeps its outline: the high-contrast sets' fill is their background,
      // where a shared chip is told by its bold alone and still drawn as a chip.
      const look = (id: string, words: string) => ({
        outlined: screen.getByTestId(id).props.className.includes("border-border"),
        filled: screen.getByTestId(id).props.className.includes("bg-secondary"),
        bold: screen.getByText(words).props.className.includes("font-semibold"),
      });
      const shared = { outlined: true, filled: true, bold: true };
      const own = { outlined: true, filled: false, bold: false };
      expect(look("chip-languages.fi", "Finnish")).toEqual(shared);
      expect(look("chip-hobbies.hiking", "Hiking")).toEqual(shared);
      expect(look("chip-languages.en", "English")).toEqual(own);
      expect(look("chip-hobbies.yoga", "Yoga")).toEqual(own);
      for (const line of texts(screen.toJSON())) expect(line).not.toMatch(/you too/i);
    });

    it.each([
      ["en-US", "Show the whole card", "Show less", "Smoking: Never", "Languages: Finnish, shared"],
      [
        "fi-FI",
        "Näytä koko kortti",
        "Näytä vähemmän",
        "Tupakointi: En koskaan",
        "Kielet: Suomi, yhteinen",
      ],
      ["sv-FI", "Visa hela kortet", "Visa mindre", "Rökning: Aldrig", "Språk: Finska, gemensam"],
    ])(
      "says the button, a question and a shared answer for a %s reader",
      async (tag, open, close, fact, shared) => {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
        try {
          await renderWithTheme(
            <ProfileCardView
              card={{
                ...bare,
                fields: { smoking: "never", languages: ["fi"] },
                shared: { hobbies: [], languages: ["fi"] },
                prompts,
              }}
            />,
          );
          expect(heardChips()).toEqual([fact, shared]);
          await toggle(open);
          expect(screen.getByRole("button", { name: close })).toBeTruthy();
        } finally {
          (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
        }
      },
    );
  });
});
