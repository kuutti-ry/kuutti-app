import { formatDateTime } from "@kuutti/i18n";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { AccessibilityInfo, PixelRatio, Platform } from "react-native";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader, hasCutText } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { MAX_FONT_SCALE } from "@/theme/a11y";
import { GENDER_PATH, GenderScreen } from "./GenderScreen";

// The person's own gender after sign-up (#552): the three genders from the
// stored answer, saved on leaving, the limit said up front and the date while
// it runs, and the identity label offered while non-binary is chosen with none
// stored, and taken away by a change from non-binary.

const { __navigation: navigation, __router: router } = jest.requireMock("expo-router") as {
  __navigation: { emit: (name: string, event: unknown) => void };
  __router: { replace: jest.Mock; back: jest.Mock; push: jest.Mock; dismissTo: jest.Mock };
};

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const show = async () => {
  let view: Awaited<ReturnType<typeof renderWithTheme>> | undefined;
  await act(async () => {
    view = await renderWithTheme(<GenderScreen />);
    await settle();
  });
  return view as NonNullable<typeof view>;
};
const press = (element: ReturnType<typeof screen.getByRole>) =>
  act(async () => {
    fireEvent.press(element);
    await settle();
  });
const choose = (name: string) => press(screen.getByRole("button", { name }));
const selected = (name: string) =>
  screen.getByRole("button", { name }).props.accessibilityState?.selected;

/** Leaving as the stack does it: the screen goes at once, its save on the way after it (#238). */
const leaveAndGo = async (view: Awaited<ReturnType<typeof show>>) => {
  await act(async () => {
    navigation.emit("beforeRemove", { preventDefault: jest.fn(), data: { action: {} } });
    await settle();
  });
  await act(async () => {
    view.unmount();
    await settle();
  });
};

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const envelope = (code: string, status: number) =>
  json({ error: { code, message: "no", requestId: "r" } }, status);

const FROM = "2026-12-01T12:00:00.000Z";
const WHEN = (locale: "en" | "fi" | "sv") => formatDateTime(locale, new Date(FROM));
const WAITING = `You changed this recently. Next change possible: ${WHEN("en")}.`;
const LABEL_GOES = "This also takes away the word you chose for it.";
const LEAD =
  "This is on your card, so a change reaches everybody who can see you. After a change, the next one is possible only after a waiting time.";

/** What the API keeps; a save replaces what it names, unless a refusal answers it. */
type Server = {
  gender: string | null;
  nextChange: string | null;
  label: string | undefined;
  hidden: string[];
  /** The answer to a change of gender instead of taking it. */
  genderRefusal: (() => Response) | null;
  /** The answer to a save of the profile instead of taking it. */
  profileRefusal: (() => Response) | null;
  /** The next read of the status fails. */
  statusFails: boolean;
  /** The next read of the profile fails. */
  profileFails: boolean;
  /** Every read of the status or the profile waits for this. */
  reads: Promise<void>;
};

function fakeApi(start: Partial<Server> = {}) {
  const server: Server = {
    gender: "woman",
    nextChange: null,
    label: undefined,
    hidden: [],
    genderRefusal: null,
    profileRefusal: null,
    statusFails: false,
    profileFails: false,
    reads: Promise.resolve(),
    ...start,
  };
  const writes: { path: string; body: { gender?: string; fields?: unknown } }[] = [];
  const profile = () => ({
    profile: {
      displayName: "Aino",
      bio: null,
      bioPreset: null,
      fields: { intent: "casual", ...(server.label ? { identityLabel: server.label } : {}) },
      prompts: [],
      hiddenFields: server.hidden,
      specialCategoryConsent: null,
      updatedAt: "2026-09-26T10:00:00.000Z",
    },
    completeness: { complete: false, missing: [] },
    home: null,
  });
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/onboarding") {
      await server.reads;
      if (server.statusFails) {
        server.statusFails = false;
        return envelope("server_error", 500);
      }
      return json({
        state: "active",
        age: 36,
        gender: server.gender,
        home: null,
        preferences: { seeks: ["man"], ageWindow: { min: 25, max: 40 } },
        consents: { terms: "t", privacy: "p", specialCategory: "s", research: null },
        currentVersions: { terms: "t", privacy: "p", research: "r", special_category: "s" },
        nextChange: { gender: server.nextChange },
        missing: [],
        complete: true,
      });
    }
    if (path === "/profile" && request.method === "GET") {
      await server.reads;
      if (server.profileFails) {
        server.profileFails = false;
        return envelope("server_error", 500);
      }
      return json(profile());
    }
    if (path === "/account/gender" && request.method === "PUT") {
      const body = (await request.json()) as { gender: string };
      writes.push({ path, body });
      if (server.genderRefusal) return server.genderRefusal();
      // A change away from non-binary takes the label on the API (ADR-019 §1).
      if (server.gender === "non_binary" && body.gender !== "non_binary") server.label = undefined;
      server.gender = body.gender;
      return new Response(null, { status: 204 });
    }
    if (path === "/profile" && request.method === "PUT") {
      const body = (await request.json()) as { fields: { identityLabel?: string } };
      writes.push({ path, body });
      if (server.profileRefusal) return server.profileRefusal();
      server.label = body.fields.identityLabel;
      return json(profile());
    }
    return envelope("not_found", 404);
  }) as unknown as typeof fetch;
  return { server, writes };
}

beforeEach(async () => {
  router.replace.mockClear();
  router.dismissTo.mockClear();
  router.push.mockClear();
  router.back.mockClear();
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("GenderScreen", () => {
  it("starts from the stored answer under a pinned header, every control labelled, with no Save", async () => {
    fakeApi();
    await show();
    expectPinnedHeader("Gender", "Back to your profile");
    expect(screen.getByText(LEAD)).toBeTruthy();
    expect(selected("Woman")).toBe(true);
    expect(selected("Man")).toBe(false);
    expect(selected("Non-binary")).toBe(false);
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    expect(pressables(screen.toJSON() as HostNode).flatMap((n) => a11yProblems(n))).toEqual([]);
  });

  it("goes back to the profile from the header", async () => {
    fakeApi();
    await show();
    await press(screen.getByRole("button", { name: "Back to your profile" }));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("saves a new gender once, on leaving, never on the tap", async () => {
    const { writes, server } = fakeApi();
    const view = await show();
    await choose("Man");
    expect(selected("Man")).toBe(true);
    expect(selected("Woman")).toBe(false);
    expect(writes).toEqual([]);
    await leaveAndGo(view);
    expect(writes).toEqual([{ path: "/account/gender", body: { gender: "man" } }]);
    expect(server.gender).toBe("man");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("saves nothing when nothing changed, or a change was taken back", async () => {
    const { writes } = fakeApi();
    const untouched = await show();
    await leaveAndGo(untouched);
    const backAgain = await show();
    await choose("Man");
    await choose("Woman");
    await leaveAndGo(backAgain);
    expect(writes).toEqual([]);
  });

  describe("while the limit runs", () => {
    it("says the date on arrival and keeps another gender unchosen, saying so again each time", async () => {
      const { writes } = fakeApi({ nextChange: FROM });
      const view = await show();
      expect(screen.getByText(WAITING).props.accessibilityLiveRegion).toBe("polite");
      await choose("Man");
      expect(selected("Woman")).toBe(true);
      expect(selected("Man")).toBe(false);
      expect(screen.getByText(WAITING).props.accessibilityLiveRegion).toBe("assertive");
      await leaveAndGo(view);
      expect(writes).toEqual([]);
    });

    it("says it aloud on iOS on arrival and for every press", async () => {
      jest.replaceProperty(Platform, "OS", "ios");
      // The mock outlives a test, with what earlier ones said.
      const said = jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions").mockClear();
      fakeApi({ nextChange: FROM });
      await show();
      await choose("Man");
      await choose("Man");
      expect(said.mock.calls.filter(([words]) => words === WAITING)).toHaveLength(3);
    });

    it("ends the refusal when the stored answer is pressed", async () => {
      fakeApi({ nextChange: FROM });
      await show();
      await choose("Man");
      await choose("Woman");
      expect(screen.getByText(WAITING).props.accessibilityLiveRegion).toBe("polite");
    });
  });

  describe("a save refused after the screen has gone", () => {
    /** The limit begun elsewhere since the screen read the answer. */
    const refusedByTheLimit = async (start: Partial<Server> = {}) => {
      const api = fakeApi(start);
      const view = await show();
      await choose("Man");
      api.server.nextChange = FROM;
      api.server.genderRefusal = () => envelope("change_too_soon", 429);
      await leaveAndGo(view);
      expect(router.push).toHaveBeenCalledWith(GENDER_PATH);
      const again = await show();
      return { ...api, again };
    };

    it("comes back with the change and the date, and the reason stays after Keep editing", async () => {
      await refusedByTheLimit();
      expect(selected("Man")).toBe(true);
      // The dialog's reason, and the line on the screen under it.
      expect(screen.getAllByText(WAITING)).toHaveLength(2);
      expect(screen.getByText("Leave without saving?")).toBeTruthy();
      await press(screen.getByRole("button", { name: "Keep editing" }));
      expect(screen.queryByText("Leave without saving?")).toBeNull();
      expect(screen.getByText(WAITING)).toBeTruthy();
    });

    it("lets the change go on the person's word, with no second save", async () => {
      const { writes } = await refusedByTheLimit();
      await press(screen.getByRole("button", { name: "Leave without saving" }));
      expect(router.back).toHaveBeenCalledTimes(1);
      await act(async () => {
        navigation.emit("beforeRemove", { preventDefault: jest.fn(), data: { action: {} } });
        await settle();
      });
      expect(writes).toHaveLength(1);
    });

    it("lets the stored answer undo the change, and then there is nothing to save", async () => {
      const { writes, again } = await refusedByTheLimit();
      await press(screen.getByRole("button", { name: "Keep editing" }));
      await choose("Woman");
      expect(selected("Woman")).toBe(true);
      await leaveAndGo(again);
      expect(writes).toHaveLength(1);
    });

    it("says the refusal in its own words where the date cannot be known", async () => {
      const api = fakeApi();
      const view = await show();
      await choose("Man");
      api.server.genderRefusal = () => envelope("change_too_soon", 429);
      await leaveAndGo(view);
      await show();
      expect(
        screen.getByText(
          "You changed this recently. A change is possible again once the waiting time has passed.",
        ),
      ).toBeTruthy();
    });

    it("keeps a refused change for any other reason, and saves it on the next leaving", async () => {
      const api = fakeApi();
      const view = await show();
      await choose("Man");
      api.server.genderRefusal = () => envelope("server_error", 500);
      await leaveAndGo(view);
      const again = await show();
      expect(selected("Man")).toBe(true);
      expect(screen.getByText("It could not be saved. Try again.")).toBeTruthy();
      await press(screen.getByRole("button", { name: "Keep editing" }));
      api.server.genderRefusal = null;
      router.push.mockClear();
      await leaveAndGo(again);
      expect(api.server.gender).toBe("man");
      expect(router.push).not.toHaveBeenCalled();
    });

    it("comes back with the change when the network is what failed", async () => {
      const api = fakeApi();
      const view = await show();
      await choose("Man");
      api.server.genderRefusal = () => {
        throw new TypeError("Network request failed");
      };
      await leaveAndGo(view);
      await show();
      expect(selected("Man")).toBe(true);
      expect(screen.getByText("It could not be saved. Try again.")).toBeTruthy();
    });

    it("keeps a held change through a read that failed too, and tries it again on leaving", async () => {
      const api = fakeApi();
      const view = await show();
      await choose("Man");
      api.server.genderRefusal = () => envelope("server_error", 500);
      await leaveAndGo(view);
      api.server.statusFails = true;
      const again = await show();
      expect(screen.queryByText("Your profile could not be loaded.")).toBeNull();
      expect(selected("Man")).toBe(true);
      expect(screen.getByRole("button", { name: "Leave without saving" })).toBeTruthy();
      await press(screen.getByRole("button", { name: "Keep editing" }));
      api.server.genderRefusal = null;
      await leaveAndGo(again);
      expect(api.server.gender).toBe("man");
    });

    it("keeps a held word through a refusal while the profile cannot be read", async () => {
      const api = fakeApi();
      const view = await show();
      await choose("Non-binary");
      await choose("Genderfluid");
      api.server.genderRefusal = () => envelope("server_error", 500);
      await leaveAndGo(view);
      api.server.profileFails = true;
      const again = await show();
      await press(screen.getByRole("button", { name: "Keep editing" }));
      await leaveAndGo(again);
      await show();
      expect(selected("Non-binary")).toBe(true);
      expect(selected("Genderfluid")).toBe(true);
    });

    it("sends a held word once it can, with the profile unread on the way back", async () => {
      const api = fakeApi({ gender: "non_binary" });
      const view = await show();
      await choose("Agender");
      api.server.profileRefusal = () => {
        throw new TypeError("Network request failed");
      };
      await leaveAndGo(view);
      api.server.profileFails = true;
      const again = await show();
      expect(selected("Agender")).toBe(true);
      await press(screen.getByRole("button", { name: "Keep editing" }));
      api.server.profileRefusal = null;
      await leaveAndGo(again);
      expect(api.server.label).toBe("agender");
    });

    it("sends a held word after its gender, with the profile unread on the way back", async () => {
      const api = fakeApi();
      const view = await show();
      await choose("Non-binary");
      await choose("Genderfluid");
      api.server.genderRefusal = () => envelope("server_error", 500);
      await leaveAndGo(view);
      api.server.profileFails = true;
      const again = await show();
      await press(screen.getByRole("button", { name: "Keep editing" }));
      api.server.genderRefusal = null;
      await leaveAndGo(again);
      expect(api.server.gender).toBe("non_binary");
      expect(api.server.label).toBe("genderfluid");
    });

    it("holds the last word pressed, never an older one", async () => {
      const api = fakeApi();
      const view = await show();
      await choose("Non-binary");
      await choose("Genderfluid");
      api.server.genderRefusal = () => envelope("server_error", 500);
      await leaveAndGo(view);
      api.server.profileFails = true;
      const again = await show();
      await press(screen.getByRole("button", { name: "Keep editing" }));
      await choose("Agender");
      await leaveAndGo(again);
      const last = await show();
      expect(selected("Agender")).toBe(true);
      expect(selected("Genderfluid")).toBe(false);
      await press(screen.getByRole("button", { name: "Keep editing" }));
      api.server.genderRefusal = null;
      await leaveAndGo(last);
      expect(api.server.label).toBe("agender");
    });

    it("keeps a held word when somebody leaves while the reads are on their way", async () => {
      const api = fakeApi();
      const view = await show();
      await choose("Non-binary");
      await choose("Genderfluid");
      api.server.genderRefusal = () => envelope("server_error", 500);
      await leaveAndGo(view);
      let answer = () => {};
      api.server.reads = new Promise<void>((resolve) => {
        answer = resolve;
      });
      const again = await show();
      expect(screen.getByText("Loading your profile…")).toBeTruthy();
      api.server.genderRefusal = null;
      await leaveAndGo(again);
      await act(async () => {
        answer();
        await settle();
      });
      expect(api.server.gender).toBe("non_binary");
      expect(api.server.label).toBe("genderfluid");
    });

    it("brings the word back with a refused gender, and neither went through", async () => {
      const api = fakeApi();
      const view = await show();
      await choose("Non-binary");
      await choose("Genderfluid");
      api.server.genderRefusal = () => envelope("server_error", 500);
      await leaveAndGo(view);
      expect(api.writes.map((w) => w.path)).toEqual(["/account/gender"]);
      await show();
      expect(selected("Non-binary")).toBe(true);
      expect(selected("Genderfluid")).toBe(true);
    });

    it("keeps the word offered when only the word was refused", async () => {
      const api = fakeApi();
      const view = await show();
      await choose("Non-binary");
      await choose("Genderfluid");
      api.server.profileRefusal = () => envelope("validation_failed", 400);
      await leaveAndGo(view);
      expect(api.server.gender).toBe("non_binary");
      const again = await show();
      expect(selected("Non-binary")).toBe(true);
      expect(selected("Genderfluid")).toBe(true);
      await press(screen.getByRole("button", { name: "Keep editing" }));
      api.server.profileRefusal = null;
      await leaveAndGo(again);
      expect(api.server.label).toBe("genderfluid");
      expect(api.writes.filter((w) => w.path === "/account/gender")).toHaveLength(1);
    });
  });

  describe("the identity label", () => {
    const WORD = "A word for it, if you like";
    const SHOWN = "The word is shown on your card and never used for matching.";

    it("is not offered to a woman or a man", async () => {
      fakeApi();
      await show();
      expect(screen.queryByText(WORD)).toBeNull();
      await choose("Man");
      expect(screen.queryByText(WORD)).toBeNull();
    });

    it("is offered on a change to non-binary, sent after the gender was accepted", async () => {
      const { writes } = fakeApi();
      const view = await show();
      await choose("Non-binary");
      expect(screen.getByText(WORD)).toBeTruthy();
      expect(screen.getByText(SHOWN)).toBeTruthy();
      await choose("Genderfluid");
      expect(selected("Genderfluid")).toBe(true);
      await leaveAndGo(view);
      expect(writes.map((w) => w.path)).toEqual(["/account/gender", "/profile"]);
      expect(writes[1]?.body.fields).toEqual({ intent: "casual", identityLabel: "genderfluid" });
    });

    it("sends the gender alone when no word was chosen, or a chosen one was taken back", async () => {
      const { writes } = fakeApi();
      const view = await show();
      await choose("Non-binary");
      await choose("Genderfluid");
      await choose("Genderfluid");
      expect(selected("Genderfluid")).toBe(false);
      await leaveAndGo(view);
      expect(writes.map((w) => w.path)).toEqual(["/account/gender"]);
    });

    it("is offered to somebody already non-binary with none, and saves the word alone", async () => {
      const { writes } = fakeApi({ gender: "non_binary" });
      const view = await show();
      expect(screen.getByText(WORD)).toBeTruthy();
      await choose("Agender");
      await leaveAndGo(view);
      expect(writes.map((w) => w.path)).toEqual(["/profile"]);
    });

    it("is not offered to somebody who has one: Basics is its door", async () => {
      fakeApi({ gender: "non_binary", label: "genderfluid" });
      await show();
      expect(screen.queryByText(WORD)).toBeNull();
      expect(screen.queryByText(LABEL_GOES)).toBeNull();
    });

    it("says beforehand that a change away from non-binary takes it, and leaves that to the API", async () => {
      const { writes, server } = fakeApi({ gender: "non_binary", label: "genderfluid" });
      const view = await show();
      await choose("Man");
      expect(screen.getByText(LABEL_GOES).props.accessibilityLiveRegion).toBe("polite");
      await choose("Non-binary");
      expect(screen.queryByText(LABEL_GOES)).toBeNull();
      await choose("Woman");
      await leaveAndGo(view);
      expect(writes).toEqual([{ path: "/account/gender", body: { gender: "woman" } }]);
      expect(server.label).toBeUndefined();
    });

    it("says nothing about a word when there is none to lose", async () => {
      fakeApi({ gender: "non_binary" });
      await show();
      await choose("Man");
      expect(screen.queryByText(LABEL_GOES)).toBeNull();
    });

    it("says nothing of a word the change leaves where it is", async () => {
      // The screens never offer one here, the API lets it through, and only leaving non-binary takes it.
      fakeApi({ label: "genderfluid" });
      await show();
      await choose("Man");
      expect(screen.queryByText(LABEL_GOES)).toBeNull();
    });

    it("says where a stored hide keeps the word off the card, in place of saying it shows", async () => {
      fakeApi({ gender: "non_binary", hidden: ["identityLabel"] });
      await show();
      expect(screen.getByText(WORD)).toBeTruthy();
      expect(screen.getByText("Hidden from your card.")).toBeTruthy();
      expect(screen.queryByText(SHOWN)).toBeNull();
    });

    it("does not send a word left behind for another gender", async () => {
      const { writes } = fakeApi();
      const view = await show();
      await choose("Non-binary");
      await choose("Genderfluid");
      await choose("Man");
      await leaveAndGo(view);
      expect(writes).toEqual([{ path: "/account/gender", body: { gender: "man" } }]);
    });
  });

  describe("reading", () => {
    it("says so while the answers are on their way", async () => {
      globalThis.fetch = jest.fn(() => new Promise(() => undefined)) as unknown as typeof fetch;
      await show();
      expect(screen.getByText("Loading your profile…")).toBeTruthy();
    });

    it.each([
      ["the status", { statusFails: true }],
      ["the profile", { profileFails: true }],
    ])("says when %s could not be read, and Try again reads it", async (_, failing) => {
      fakeApi(failing);
      await show();
      expect(screen.getByText("Your profile could not be loaded.")).toBeTruthy();
      await press(screen.getByRole("button", { name: /try again/i }));
      await waitFor(() => expect(selected("Woman")).toBe(true));
    });

    it("sends somebody with no gender yet back to Home, whose gate asks", async () => {
      fakeApi({ gender: null });
      await show();
      expect(router.dismissTo).toHaveBeenCalledWith("/");
      expect(router.replace).not.toHaveBeenCalled();
    });
  });

  it("cuts no text at the largest size, with everything on the screen at once", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(MAX_FONT_SCALE);
    fakeApi({ gender: "non_binary", nextChange: FROM });
    await show();
    expect(screen.getByText(WAITING)).toBeTruthy();
    expect(screen.getByText("A word for it, if you like")).toBeTruthy();
    expect(hasCutText(screen.toJSON() as HostNode)).toBe(false);
  });

  it.each([
    [
      "fi-FI",
      "Sukupuoli",
      "Mies",
      `Muutit tätä äskettäin. Seuraava muutos mahdollinen: ${WHEN("fi")}.`,
    ],
    ["sv-FI", "Kön", "Man", `Du ändrade det här nyligen. Nästa ändring möjlig: ${WHEN("sv")}.`],
  ])("speaks %s", async (tag, title, man, waiting) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
    fakeApi({ nextChange: FROM });
    await show();
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    expect(screen.getByRole("button", { name: man })).toBeTruthy();
    expect(screen.getByText(waiting)).toBeTruthy();
  });
});
