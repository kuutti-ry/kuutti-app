import type { StarredPerson } from "@kuutti/schema";
import { act, fireEvent, screen, within } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { clearSession, saveSession } from "@/lib/session";
import { noProblems } from "@/test/a11y";
import { FAILED_TO_LOAD } from "@/test/failed";
import { textsInOrder as said } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { StarredScreen } from "./StarredScreen";
import { StarsButton } from "./StarsButton";

// The Starred list on the phone (#575, ADR-064 §6): the people as the API gives them
// and in its order, a row that opens the card and a star that takes the star off,
// what it says while it loads, fails or holds nobody, and the home screen's line,
// there only while the list shows somebody. A card opened from it is
// RoundScreen.test.tsx's.

const { __router: router, __focus: focus } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; back: jest.Mock };
  __focus: () => void;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);

const HENNA: StarredPerson = {
  id: "7a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01",
  name: "Henna",
  age: 31,
  photo: { id: "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01", blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
};
const KATJA: StarredPerson = {
  id: "7a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a02",
  name: "Katja",
  age: 44,
  photo: null,
};

type Call = { method: string; path: string };

function api(answer: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const call = { method: request.method, path: new URL(request.url).pathname };
    calls.push(call);
    const given = answer(call);
    if (given) return given;
    if (call.path.startsWith("/photos/")) {
      return json({
        url: "https://media.test/thumb.webp",
        variant: "thumb",
        expiresAt: "2030-01-01T00:15:00.000Z",
      });
    }
    return refusal("not_found", 404);
  }) as unknown as typeof fetch;
  return calls;
}

const list =
  (...items: StarredPerson[]) =>
  (call: Call) =>
    call.path === "/stars" ? json({ items }) : undefined;

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const show = async () => {
  await renderWithTheme(<StarredScreen />);
  await settle();
};
const press = async (name: string) => {
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name }));
  });
  await settle();
};

beforeEach(async () => {
  router.push.mockReset();
  router.back.mockReset();
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  await clearSession();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("the Starred list", () => {
  it("shows the people in the API's order, each named with their age, with no line above them (#581)", async () => {
    api(list(HENNA, KATJA));
    await show();

    expect(screen.getByRole("heading", { name: "Starred" })).toBeTruthy();
    expect(said()).toEqual(["Starred", "Henna, 31", "Katja, 44"]);
    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.props.accessibilityLabel as string)
        .filter((label) => /, \d+$/.test(label)),
    ).toEqual(["Henna, 31", "Katja, 44"]);
    noProblems();
  });

  it("asks a shown photo's thumb, and no photo for somebody with none shown", async () => {
    const calls = api(list(HENNA, KATJA));
    await show();

    expect(calls.filter((call) => call.path.startsWith("/photos/")).map((c) => c.path)).toEqual([
      `/photos/${HENNA.photo?.id}/thumb`,
    ]);
    expect(screen.getByRole("image", { name: "Photo: Henna" })).toBeTruthy();
    expect(screen.queryByRole("image", { name: "Photo: Katja" })).toBeNull();
  });

  it("shows no count of anybody", async () => {
    api(list(HENNA, KATJA));
    await show();
    expect(screen.queryByText(/\b2\b/)).toBeNull();
  });

  it("opens the card from a row", async () => {
    api(list(HENNA));
    await show();

    await press("Henna, 31");

    expect(router.push).toHaveBeenCalledWith(`/stars/${HENNA.id}`);
  });

  it("takes a star off from its row, and the row goes", async () => {
    const calls = api((call) =>
      call.method === "DELETE" ? new Response(null, { status: 204 }) : list(HENNA, KATJA)(call),
    );
    await show();

    await press("Take the star off: Henna");

    expect(calls).toContainEqual({ method: "DELETE", path: `/stars/${HENNA.id}` });
    expect(screen.queryByRole("button", { name: "Henna, 31" })).toBeNull();
    expect(screen.getByRole("button", { name: "Katja, 44" })).toBeTruthy();
  });

  it("takes the row off when another phone took the star off first", async () => {
    api((call) => (call.method === "DELETE" ? refusal("not_found", 404) : list(HENNA)(call)));
    await show();

    await press("Take the star off: Henna");

    expect(screen.queryByRole("button", { name: "Henna, 31" })).toBeNull();
    expect(screen.queryByText("That did not go through. Try again.")).toBeNull();
  });

  it("says a star that was not taken off, and keeps the row", async () => {
    api((call) => (call.method === "DELETE" ? refusal("internal", 500) : list(HENNA)(call)));
    await show();

    await press("Take the star off: Henna");

    expect(screen.getByText("That did not go through. Try again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Henna, 31" })).toBeTruthy();
  });

  it.each([
    ["en-US", "Starred", "Nobody here right now."],
    ["fi-FI", "Tähdellä merkityt", "Täällä ei ole nyt ketään."],
    ["sv-FI", "Stjärnmärkta", "Ingen här just nu."],
  ])(
    "says so with nobody on the list, and never that anybody went or how anybody comes: %s",
    async (languageTag, title, words) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
      api(list());
      await show();
      expect(said()).toEqual([title, words]);
    },
  );

  it("says it is loading, in a live region", async () => {
    let answer: (response: Response) => void = () => undefined;
    globalThis.fetch = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    ) as unknown as typeof fetch;
    await renderWithTheme(<StarredScreen />);
    expect(screen.getByText("Loading…").props.accessibilityLiveRegion).toBe("polite");
    await act(async () => {
      answer(json({ items: [] }));
    });
    await settle();
  });

  it("says a failed read, and tries again", async () => {
    let failing = true;
    api((call) => {
      if (call.path !== "/stars") return undefined;
      return failing ? refusal("internal", 500) : json({ items: [HENNA] });
    });
    await show();
    expect(screen.getByText(FAILED_TO_LOAD)).toBeTruthy();

    failing = false;
    await press("Try again");

    expect(screen.getByRole("button", { name: "Henna, 31" })).toBeTruthy();
  });

  it("reads again when the screen comes back in sight, as a card opened may have taken a star off", async () => {
    let items = [HENNA, KATJA];
    api((call) => (call.path === "/stars" ? json({ items }) : undefined));
    await show();
    items = [KATJA];

    await act(async () => {
      focus();
    });
    await settle();

    expect(screen.queryByRole("button", { name: "Henna, 31" })).toBeNull();
    expect(screen.getByRole("button", { name: "Katja, 44" })).toBeTruthy();
  });

  it("keeps what it shows when a later read fails", async () => {
    let failing = false;
    api((call) => {
      if (call.path !== "/stars") return undefined;
      return failing ? refusal("internal", 500) : json({ items: [HENNA] });
    });
    await show();
    failing = true;

    await act(async () => {
      focus();
    });
    await settle();

    expect(screen.getByRole("button", { name: "Henna, 31" })).toBeTruthy();
    expect(screen.queryByText(FAILED_TO_LOAD)).toBeNull();
  });

  it("leads back home", async () => {
    api(list(HENNA));
    await show();
    await press("Back to home");
    expect(router.back).toHaveBeenCalled();
  });
});

describe("the home screen's way to the list", () => {
  const button = () => screen.queryByRole("button", { name: "Starred" });
  const showButton = async () => {
    await renderWithTheme(<StarsButton />);
    await settle();
  };

  it("is there while the list shows somebody, by its word alone, and leads to the list", async () => {
    api(list(HENNA, KATJA));
    await showButton();

    expect(within(button() as never).getByText("Starred")).toBeTruthy();
    expect(screen.queryByText(/\d/)).toBeNull();
    await press("Starred");
    expect(router.push).toHaveBeenCalledWith("/stars");
    noProblems();
  });

  it("is not there with nobody to show, or while it does not know", async () => {
    api(list());
    await showButton();
    expect(button()).toBeNull();

    api((call) => (call.path === "/stars" ? refusal("internal", 500) : undefined));
    await showButton();
    expect(button()).toBeNull();
  });

  it("goes when the last star goes, once home is back in sight", async () => {
    let items = [HENNA];
    api((call) => (call.path === "/stars" ? json({ items }) : undefined));
    await showButton();
    expect(button()).not.toBeNull();
    items = [];

    await act(async () => {
      focus();
    });
    await settle();

    expect(button()).toBeNull();
  });
});
