import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import type * as React from "react";
import { AccessibilityInfo, Platform } from "react-native";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader, hasCutText } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { DealBreakerFieldScreen } from "./DealBreakerFieldScreen";

// One deal-breaker on a screen of its own (#551): Everyone first, then what is
// fine, saved on leaving as one field of the whole set the API takes.

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const show = async (ui: React.ReactElement) => {
  let view: Awaited<ReturnType<typeof renderWithTheme>> | undefined;
  await act(async () => {
    view = await renderWithTheme(ui);
    await settle();
  });
  return view as NonNullable<typeof view>;
};
const press = (element: ReturnType<typeof screen.getByRole>) =>
  act(async () => {
    fireEvent.press(element);
    await settle();
  });
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const envelope = (code: string, status: number) =>
  json({ error: { code, message: "no", requestId: "r" } }, status);

type Filter = { field: string; accept: string[]; includeUnknown: boolean };

/** What the API keeps: the set is read and replaced whole, and paused read off the own answers. */
type Server = {
  fields: Record<string, unknown>;
  dealBreakers: Filter[];
  max: number;
  /** The answer to a save instead of taking it. */
  refusal: (() => Response) | null;
  /** Reading the deal-breakers fails. */
  failing: boolean;
  /** Reading the own answers fails. */
  noProfile: boolean;
  /** The network is gone: every request is lost. */
  offline: boolean;
  /** Every read waits for this. */
  wait: Promise<void>;
};

const ANSWERED = {
  monogamy: "monogamous",
  hasKids: "no",
  wantsKids: "want",
  smoking: "never",
  languages: ["fi"],
  height: 170,
};

function fakeApi(start: Partial<Server> = {}) {
  const server: Server = {
    fields: ANSWERED,
    dealBreakers: [],
    max: 7,
    refusal: null,
    failing: false,
    noProfile: false,
    offline: false,
    wait: Promise.resolve(),
    ...start,
  };
  const puts: Filter[][] = [];
  const reads: string[] = [];
  const stored = () => ({
    dealBreakers: server.dealBreakers.map((d) => ({
      ...d,
      paused: d.field !== "distance" && server.fields[d.field] === undefined,
    })),
    max: server.max,
  });
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "PUT") {
      const body = (await request.json()) as { dealBreakers: Filter[] };
      puts.push(body.dealBreakers);
      if (server.offline) throw new TypeError("Network request failed");
      if (server.refusal) return server.refusal();
      server.dealBreakers = body.dealBreakers;
      return json(stored());
    }
    reads.push(path);
    await server.wait;
    if (server.offline) throw new TypeError("Network request failed");
    if (path === "/preferences/deal-breakers") {
      return server.failing ? envelope("internal_error", 500) : json(stored());
    }
    if (path === "/profile") {
      if (server.noProfile) return envelope("internal_error", 500);
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
        home: null,
      });
    }
    return envelope("not_found", 404);
  }) as unknown as typeof fetch;
  return { server, puts, reads };
}

const {
  __navigation: navigation,
  __router: router,
  __focus: focus,
} = jest.requireMock("expo-router") as {
  __navigation: { emit: (name: string, event: unknown) => void };
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock };
  __focus: () => void;
};

/** The back gesture, the back button or Android's back key, as the stack reports it. */
const leave = async () => {
  const event = { preventDefault: jest.fn(), data: { action: { type: "GO_BACK" } } };
  await act(async () => {
    navigation.emit("beforeRemove", event);
    await settle();
  });
  return event;
};
/** Leaving as the stack does it: the screen goes at once, its save on the way after it (#238). */
const leaveAndGo = async (view: Awaited<ReturnType<typeof show>>) => {
  await leave();
  await act(async () => {
    view.unmount();
    await settle();
  });
};
const backInFront = () =>
  act(async () => {
    focus();
    await settle();
  });

const EXPLAIN = "It works both ways: it also decides who sees you.";
const EVERYONE = "Everyone";
const UNKNOWN = "Also people who did not answer";
const AGAIN = "Back to Everyone.";
const GATED = "To filter on this, share yours first.";
const PAUSED = "Paused until you answer it yourself.";
const ANSWER = "Answer it";
const FAILED = "It could not be saved. Try again.";
const LOAD_FAILED = "Your profile could not be loaded.";
const THE_QUESTION = "Leave without saving?";

const button = (name: string) => screen.getByRole("button", { name });
const selected = (name: string) => button(name).props.accessibilityState?.selected;
const disabled = (name: string) => button(name).props.accessibilityState?.disabled;
const unknownSwitch = () => screen.getByLabelText(UNKNOWN);
const buttons = () =>
  screen
    .getAllByRole("button")
    .map((node) => node.props.accessibilityLabel ?? within(node))
    .filter(Boolean);
/** A plain text button labels itself: its words are its one child's. */
function within(node: { props: { children?: unknown } }): unknown {
  const words: string[] = [];
  const walk = (child: unknown) => {
    if (typeof child === "string") words.push(child);
    else if (Array.isArray(child)) child.forEach(walk);
    else if (child && typeof child === "object" && "props" in child) {
      walk((child as { props: { children?: unknown } }).props.children);
    }
  };
  walk(node.props.children);
  return words.join("");
}

const checkA11y = () => {
  const found = pressables(screen.toJSON() as HostNode);
  expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  expect(hasCutText(screen.toJSON() as HostNode)).toBe(false);
};

const opened = async (field: string, start?: Partial<Server>) => {
  const api = fakeApi(start);
  const view = await show(<DealBreakerFieldScreen field={field} />);
  await waitFor(() => expect(screen.getByText(EXPLAIN)).toBeTruthy());
  return { ...api, view };
};

const smoking: Filter = { field: "smoking", accept: ["never"], includeUnknown: false };
const kids: Filter = { field: "hasKids", accept: ["no"], includeUnknown: true };
const taller: Filter = { field: "height", accept: ["taller"], includeUnknown: true };

beforeEach(async () => {
  router.push.mockClear();
  router.replace.mockClear();
  router.back.mockClear();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});
afterEach(() => jest.restoreAllMocks());

describe("DealBreakerFieldScreen", () => {
  it("keeps the field's name and the way back pinned above the answers", async () => {
    await opened("smoking");
    expectPinnedHeader("Smoking", "Back");
    await press(button("Back"));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("says that it works both ways, and counts nobody", async () => {
    await opened("smoking");
    expect(screen.getByText(EXPLAIN)).toBeTruthy();
    expect(JSON.stringify(screen.toJSON())).not.toMatch(/\b\d+ (people|more)\b/);
  });

  it("opens on Everyone, the answers after it in the registry's order, with no switch", async () => {
    await opened("smoking");
    expect(selected(EVERYONE)).toBe(true);
    expect(buttons()).toEqual([
      "Back",
      EVERYONE,
      "Never",
      "Sometimes",
      "Regularly",
      "Quitting",
      "Vaping",
    ]);
    for (const name of ["Never", "Sometimes", "Regularly", "Quitting", "Vaping"]) {
      expect(selected(name)).toBe(false);
    }
    expect(screen.getByText("Fine with me")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    // Nothing of the screen it replaced: no Save, no switch to turn the filter on.
    expect(screen.queryByText("Save the deal-breakers")).toBeNull();
    expect(screen.queryByLabelText("Deal-breaker: Smoking")).toBeNull();
    checkA11y();
  });

  it("takes answers, which takes Everyone off, and the switch comes on by default (ADR-042 §8)", async () => {
    await opened("smoking");
    await press(button("Never"));
    await press(button("Quitting"));
    expect(selected(EVERYONE)).toBe(false);
    expect(selected("Never")).toBe(true);
    expect(selected("Quitting")).toBe(true);
    expect(selected("Regularly")).toBe(false);
    expect(unknownSwitch().props.accessibilityState?.checked).toBe(true);
    expect(unknownSwitch().props.accessibilityState?.disabled).toBe(false);
    expect(screen.queryByText(AGAIN)).toBeNull();
    checkA11y();
  });

  describe("the last answer taken back", () => {
    it("returns to Everyone, the switch going with it, and says so politely", async () => {
      await opened("smoking");
      await press(button("Never"));
      await press(button("Never"));
      expect(selected(EVERYONE)).toBe(true);
      expect(selected("Never")).toBe(false);
      expect(screen.queryByRole("switch")).toBeNull();
      expect(screen.getByText(AGAIN).props.accessibilityLiveRegion).toBe("polite");
    });

    it("is said aloud on iOS, which has no live region", async () => {
      jest.replaceProperty(Platform, "OS", "ios");
      const said = jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions");
      said.mockClear();
      await opened("smoking");
      await press(button("Never"));
      expect(said).not.toHaveBeenCalled();
      await press(button("Never"));
      expect(said.mock.calls).toEqual([[AGAIN, { queue: true }]]);
    });

    it("is said no more once another answer is chosen", async () => {
      await opened("smoking");
      await press(button("Never"));
      await press(button("Never"));
      await press(button("Quitting"));
      expect(screen.queryByText(AGAIN)).toBeNull();
    });

    it("says nothing while another answer stays", async () => {
      await opened("smoking");
      await press(button("Never"));
      await press(button("Quitting"));
      await press(button("Never"));
      expect(screen.queryByText(AGAIN)).toBeNull();
      expect(selected(EVERYONE)).toBe(false);
      expect(selected("Quitting")).toBe(true);
    });
  });

  it("takes every answer off on Everyone, which it needs no word for: the press is on it", async () => {
    await opened("smoking", {
      dealBreakers: [{ ...smoking, accept: ["never", "quitting"] }],
    });
    await press(button(EVERYONE));
    expect(selected(EVERYONE)).toBe(true);
    expect(selected("Never")).toBe(false);
    expect(selected("Quitting")).toBe(false);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText(AGAIN)).toBeNull();
  });

  it("stays on Everyone when Everyone is pressed again", async () => {
    const { puts } = await opened("smoking");
    await press(button(EVERYONE));
    expect(selected(EVERYONE)).toBe(true);
    await leave();
    expect(puts).toEqual([]);
  });

  describe("saving on leaving", () => {
    it("sends its one field beside the others as they stand, once, and nothing before it", async () => {
      const { puts } = await opened("smoking", { dealBreakers: [kids] });
      await press(button("Never"));
      await press(button("Quitting"));
      expect(puts).toEqual([]);
      await leave();
      expect(puts).toEqual([
        [kids, { field: "smoking", accept: ["never", "quitting"], includeUnknown: true }],
      ]);
      await leave();
      expect(puts).toHaveLength(1);
    });

    it("reads the set when the save goes: another screen's change is kept", async () => {
      const { server, puts } = await opened("smoking");
      await press(button("Never"));
      server.dealBreakers = [taller];
      await leave();
      expect(puts).toEqual([
        [taller, { field: "smoking", accept: ["never"], includeUnknown: true }],
      ]);
    });

    it("takes it off with Everyone, the others kept", async () => {
      const { puts } = await opened("smoking", { dealBreakers: [smoking, kids] });
      await press(button(EVERYONE));
      await leave();
      expect(puts).toEqual([[kids]]);
    });

    it("sends a paused neighbour back as it stands, without saying it is paused", async () => {
      const { puts } = await opened("hasKids", {
        fields: { ...ANSWERED, smoking: undefined },
        dealBreakers: [smoking],
      });
      await press(button("No kids"));
      await leave();
      expect(puts).toEqual([[smoking, { field: "hasKids", accept: ["no"], includeUnknown: true }]]);
    });

    it("shows the switch as stored and sends a change of it", async () => {
      const { puts } = await opened("smoking", { dealBreakers: [smoking] });
      expect(unknownSwitch().props.accessibilityState?.checked).toBe(false);
      await press(unknownSwitch());
      expect(unknownSwitch().props.accessibilityState?.checked).toBe(true);
      await leave();
      expect(puts).toEqual([[{ ...smoking, includeUnknown: true }]]);
    });

    it.each([
      ["nothing changed", []],
      ["a change taken back", ["Quitting", "Quitting"]],
      ["Everyone, and the same answer again", [EVERYONE, "Never"]],
    ])("sends nothing for %s", async (_what, presses) => {
      const { puts } = await opened("smoking", {
        dealBreakers: [{ ...smoking, includeUnknown: true }],
      });
      for (const name of presses) await press(button(name));
      expect((await leave()).preventDefault).not.toHaveBeenCalled();
      expect(puts).toEqual([]);
    });

    it("sends nothing for the same answers pressed in another order", async () => {
      const { puts } = await opened("smoking", {
        dealBreakers: [{ ...smoking, accept: ["quitting", "never"], includeUnknown: true }],
      });
      await press(button("Quitting"));
      await press(button("Quitting"));
      await leave();
      expect(puts).toEqual([]);
    });

    it("sends nothing for the switch moved and the answers taken back: Everyone has no switch", async () => {
      const { puts } = await opened("smoking");
      await press(button("Never"));
      await press(unknownSwitch());
      await press(button("Never"));
      await leave();
      expect(puts).toEqual([]);
    });

    it("keeps the switch moved when answers are taken back and given on the same visit", async () => {
      const { puts } = await opened("smoking");
      await press(button("Never"));
      await press(unknownSwitch());
      await press(button("Never"));
      await press(button("Quitting"));
      await leave();
      expect(puts).toEqual([[{ field: "smoking", accept: ["quitting"], includeUnknown: false }]]);
    });
  });

  describe("the number a person may hold", () => {
    it("refuses a new one past it, in words, heard again at each press, and sends nothing", async () => {
      jest.replaceProperty(Platform, "OS", "ios");
      const said = jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions");
      said.mockClear();
      const { puts } = await opened("hasKids", { dealBreakers: [smoking], max: 1 });
      await press(button("No kids"));
      const words = "That is 1 already.";
      expect(screen.getByText(words).props.accessibilityLiveRegion).toBe("assertive");
      expect(selected(EVERYONE)).toBe(true);
      expect(selected("No kids")).toBe(false);
      await press(button("No kids"));
      expect(said.mock.calls).toEqual([
        [words, { queue: true }],
        [words, { queue: true }],
      ]);
      await leave();
      expect(puts).toEqual([]);
    });

    it("refuses a first relation and a first band as one more", async () => {
      await opened("height", { dealBreakers: [smoking], max: 1 });
      await press(button("Taller than me"));
      expect(screen.getByText("That is 1 already.")).toBeTruthy();
      expect(selected(EVERYONE)).toBe(true);
    });

    it("takes the last one the number allows", async () => {
      const { puts } = await opened("hasKids", { dealBreakers: [smoking], max: 2 });
      await press(button("No kids"));
      expect(screen.queryByText("That is 2 already.")).toBeNull();
      await leave();
      expect(puts).toEqual([[smoking, { field: "hasKids", accept: ["no"], includeUnknown: true }]]);
    });

    it("lets one held past a lowered number change, and come back after Everyone", async () => {
      const { puts } = await opened("smoking", { dealBreakers: [smoking, kids, taller], max: 1 });
      await press(button("Quitting"));
      expect(screen.queryByText("That is 1 already.")).toBeNull();
      await press(button(EVERYONE));
      await press(button("Never"));
      expect(screen.queryByText("That is 1 already.")).toBeNull();
      expect(selected("Never")).toBe(true);
      await press(button("Vaping"));
      await leave();
      expect(puts).toEqual([[kids, taller, { ...smoking, accept: ["never", "vaping"] }]]);
    });

    it("lets one held past a lowered number go", async () => {
      const { puts } = await opened("smoking", { dealBreakers: [smoking, kids, taller], max: 1 });
      await press(button(EVERYONE));
      await leave();
      expect(puts).toEqual([[kids, taller]]);
    });

    it("says the refusal no more once the next press does anything", async () => {
      await opened("hasKids", { dealBreakers: [smoking], max: 1 });
      await press(button("No kids"));
      expect(screen.getByText("That is 1 already.")).toBeTruthy();
      await press(button(EVERYONE));
      expect(screen.queryByText("That is 1 already.")).toBeNull();
    });

    it("never counts the second answer of a new one", async () => {
      await opened("smoking", { dealBreakers: [kids], max: 2 });
      await press(button("Never"));
      await press(button("Quitting"));
      expect(screen.queryByText("That is 2 already.")).toBeNull();
      expect(selected("Quitting")).toBe(true);
    });
  });

  describe("height (#508)", () => {
    it("has its three relations after Everyone, under the same heading", async () => {
      await opened("height");
      expect(buttons()).toEqual([
        "Back",
        EVERYONE,
        "Taller than me",
        "My height or taller",
        "Shorter than me",
      ]);
      expect(selected(EVERYONE)).toBe(true);
      expect(screen.getByText("Fine with me")).toBeTruthy();
      expect(screen.queryByRole("switch")).toBeNull();
      checkA11y();
    });

    it("takes one relation at a time, and sends it", async () => {
      const { puts } = await opened("height");
      await press(button("Taller than me"));
      await press(button("Shorter than me"));
      expect(selected("Taller than me")).toBe(false);
      expect(selected("Shorter than me")).toBe(true);
      expect(selected(EVERYONE)).toBe(false);
      expect(unknownSwitch().props.accessibilityState?.checked).toBe(true);
      await leave();
      expect(puts).toEqual([[{ field: "height", accept: ["shorter"], includeUnknown: true }]]);
    });

    it("returns to Everyone when its relation is pressed again, and says so", async () => {
      const { puts } = await opened("height", { dealBreakers: [taller] });
      await press(button("Taller than me"));
      expect(selected(EVERYONE)).toBe(true);
      expect(screen.getByText(AGAIN)).toBeTruthy();
      await leave();
      expect(puts).toEqual([[]]);
    });

    it("shows a stored relation with its switch, and sends the switch back with a new one", async () => {
      const { puts } = await opened("height", {
        dealBreakers: [{ field: "height", accept: ["at_least_mine"], includeUnknown: false }],
      });
      expect(selected("My height or taller")).toBe(true);
      expect(unknownSwitch().props.accessibilityState?.checked).toBe(false);
      await press(button("Taller than me"));
      await leave();
      expect(puts).toEqual([[{ field: "height", accept: ["taller"], includeUnknown: false }]]);
    });
  });

  describe("the distance (#514, ADR-061 §7)", () => {
    const nearby: Filter = { field: "distance", accept: ["nearby"], includeUnknown: true };

    it("has three bands after Everyone, Far being no filter, and nothing on those who did not answer", async () => {
      await opened("distance");
      expect(buttons()).toEqual(["Back", EVERYONE, "Nearby", "Close", "Around"]);
      expect(selected(EVERYONE)).toBe(true);
      checkA11y();
    });

    it("is open with nothing answered: a home is everybody's, so it is never gated", async () => {
      await opened("distance", { fields: {} });
      expect(screen.queryByText(GATED)).toBeNull();
      expect(screen.queryByRole("button", { name: ANSWER })).toBeNull();
      await press(button("Close"));
      expect(selected("Close")).toBe(true);
    });

    it("is never paused, whatever the person has not answered", async () => {
      await opened("distance", { fields: {}, dealBreakers: [nearby] });
      expect(screen.queryByText(PAUSED)).toBeNull();
      expect(selected("Nearby")).toBe(true);
      expect(disabled("Nearby")).toBe(false);
    });

    it("takes a band with the nearer ones, one button chosen, and sends them as a list", async () => {
      const { puts } = await opened("distance");
      await press(button("Close"));
      expect(selected("Close")).toBe(true);
      expect(selected("Nearby")).toBe(false);
      expect(selected("Around")).toBe(false);
      // Nothing on those who did not answer, once it is on either: everybody has a home.
      expect(screen.queryByRole("switch")).toBeNull();
      await leave();
      expect(puts).toEqual([
        [{ field: "distance", accept: ["nearby", "close"], includeUnknown: true }],
      ]);
    });

    it.each([
      ["a list of one", ["nearby"], "Nearby"],
      ["a band with the nearer ones", ["nearby", "close"], "Close"],
      ["every band a filter takes", ["nearby", "close", "around"], "Around"],
      ["a list in another order", ["close", "nearby"], "Close"],
      ["a list with a gap", ["nearby", "around"], "Around"],
    ])("shows %s by its farthest band", async (_what, accept, chosen) => {
      await opened("distance", { dealBreakers: [{ ...nearby, accept }] });
      for (const name of ["Nearby", "Close", "Around"]) {
        expect(selected(name)).toBe(name === chosen);
      }
    });

    it("returns to Everyone when its band is pressed again", async () => {
      const { puts } = await opened("distance", {
        dealBreakers: [{ ...nearby, accept: ["nearby", "close"] }],
      });
      await press(button("Close"));
      expect(selected(EVERYONE)).toBe(true);
      await leave();
      expect(puts).toEqual([[]]);
    });

    it("comes off on Everyone", async () => {
      const { puts } = await opened("distance", { dealBreakers: [nearby] });
      await press(button(EVERYONE));
      await leave();
      expect(puts).toEqual([[]]);
    });
  });

  describe("the languages", () => {
    it("searches its long list, Everyone staying where it is", async () => {
      await opened("languages");
      expect(button("Finnish")).toBeTruthy();
      await act(async () => {
        fireEvent.changeText(screen.getByLabelText("Search"), " GERM ");
        await settle();
      });
      expect(button("German")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Finnish" })).toBeNull();
      expect(button(EVERYONE)).toBeTruthy();
      expect(screen.getByLabelText("Search").props.value).toBe(" GERM ");
    });

    it("leads with the first ten, as their picker does, and keeps an accepted one in view (#239)", async () => {
      await opened("languages", {
        dealBreakers: [{ field: "languages", accept: ["fi", "de"], includeUnknown: false }],
      });
      expect(button("Somali")).toBeTruthy();
      expect(button("German")).toBeTruthy();
      expect(button("Another language")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "French" })).toBeNull();
      // Taken back, an accepted language beyond the ten stays to be accepted again.
      await press(button("German"));
      expect(selected("German")).toBe(false);
      await press(button("German"));
      expect(selected("German")).toBe(true);
    });

    it("keeps a language found by searching in view once the search is cleared", async () => {
      await opened("languages");
      await act(async () => {
        fireEvent.changeText(screen.getByLabelText("Search"), "French");
        await settle();
      });
      await press(button("French"));
      await press(button("French"));
      await act(async () => {
        fireEvent.changeText(screen.getByLabelText("Search"), "");
        await settle();
      });
      expect(selected("French")).toBe(false);
      expect(selected(EVERYONE)).toBe(true);
    });

    it("has no search on a short list", async () => {
      await opened("smoking");
      expect(screen.queryByLabelText("Search")).toBeNull();
    });
  });

  describe("with the person's own answer missing", () => {
    it.each([
      [
        "a field of the later screens opens its own, for one answer",
        "hasKids",
        { pathname: "/profile/later/[field]", params: { field: "hasKids", once: "1" } },
      ],
      [
        "height the same",
        "height",
        { pathname: "/profile/later/[field]", params: { field: "height", once: "1" } },
      ],
      [
        "a field without a later screen opens the section that holds it (#239, #542)",
        "monogamy",
        { pathname: "/profile/section/[id]", params: { id: "relationship", once: "1" } },
      ],
    ])("%s", async (_what, field, path) => {
      const { puts } = await opened(field, { fields: {} });
      expect(screen.getByText(GATED)).toBeTruthy();
      expect(buttons()).toEqual(["Back", ANSWER]);
      expect(screen.queryByText("Fine with me")).toBeNull();
      expect(screen.queryByRole("switch")).toBeNull();
      checkA11y();
      await press(button(ANSWER));
      expect(router.push).toHaveBeenCalledWith(path);
      await leave();
      expect(puts).toEqual([]);
    });
  });

  describe("a deal-breaker paused", () => {
    const paused = (extra?: Partial<Server>) =>
      opened("smoking", {
        fields: { ...ANSWERED, smoking: undefined },
        dealBreakers: [{ ...smoking, accept: ["never", "quitting"] }],
        ...extra,
      });

    it("says so in words, with one way to the answer, and what stands drawn read-only", async () => {
      const { puts } = await paused();
      expect(screen.getByText(PAUSED)).toBeTruthy();
      expect(screen.queryByText(GATED)).toBeNull();
      expect(buttons()).toEqual(["Back", ANSWER, EVERYONE, "Never", "Quitting"]);
      for (const name of ["Never", "Quitting"]) {
        expect(selected(name)).toBe(true);
        expect(disabled(name)).toBe(true);
      }
      expect(disabled(EVERYONE)).toBe(false);
      expect(selected(EVERYONE)).toBe(false);
      expect(unknownSwitch().props.accessibilityState).toMatchObject({
        checked: false,
        disabled: true,
      });
      checkA11y();
      await press(button(ANSWER));
      expect(router.push).toHaveBeenCalledWith({
        pathname: "/profile/later/[field]",
        params: { field: "smoking", once: "1" },
      });
      await leave();
      expect(puts).toEqual([]);
    });

    it("changes nothing on a press of what is drawn read-only", async () => {
      const { puts } = await paused();
      await press(button("Never"));
      await press(unknownSwitch());
      expect(selected("Never")).toBe(true);
      expect(unknownSwitch().props.accessibilityState?.checked).toBe(false);
      await leave();
      expect(puts).toEqual([]);
    });

    it("draws what stands of a long list too, past its first ten, with no search over it", async () => {
      await opened("languages", {
        fields: {},
        dealBreakers: [{ field: "languages", accept: ["fi", "de"], includeUnknown: true }],
      });
      expect(buttons()).toEqual(["Back", ANSWER, EVERYONE, "Finnish", "German"]);
      expect(screen.queryByLabelText("Search")).toBeNull();
      expect(unknownSwitch().props.accessibilityState).toMatchObject({
        checked: true,
        disabled: true,
      });
    });

    it("comes off on Everyone: the line changes, it is said, and leaving sends the rest", async () => {
      const { puts } = await paused();
      await press(button(EVERYONE));
      expect(screen.queryByText(PAUSED)).toBeNull();
      expect(screen.getByText(GATED)).toBeTruthy();
      expect(screen.getByText(AGAIN)).toBeTruthy();
      expect(buttons()).toEqual(["Back", ANSWER]);
      await leave();
      expect(puts).toEqual([[]]);
    });
  });

  describe("the way back from Answer it (#542)", () => {
    it("reads the person's own answers once on the first focus, no more", async () => {
      const { reads } = await opened("smoking");
      expect(reads.toSorted()).toEqual(["/preferences/deal-breakers", "/profile"]);
    });

    it("reads them again when it is back in front, which opens what was gated", async () => {
      const { server, reads } = await opened("hasKids", { fields: {} });
      server.fields = { hasKids: "no" };
      await backInFront();
      expect(screen.queryByText(GATED)).toBeNull();
      expect(screen.queryByRole("button", { name: ANSWER })).toBeNull();
      expect(selected(EVERYONE)).toBe(true);
      expect(button("No kids")).toBeTruthy();
      expect(reads.filter((path) => path === "/profile")).toHaveLength(2);
      // The deal-breakers are this screen's own to hold while it is open.
      expect(reads.filter((path) => path === "/preferences/deal-breakers")).toHaveLength(1);
    });

    it("takes a pause off the same way, every answer back and the filter as it was", async () => {
      const { server, puts } = await opened("smoking", {
        fields: {},
        dealBreakers: [smoking],
      });
      expect(screen.getByText(PAUSED)).toBeTruthy();
      server.fields = { smoking: "never" };
      await backInFront();
      expect(screen.queryByText(PAUSED)).toBeNull();
      expect(selected("Never")).toBe(true);
      expect(disabled("Never")).toBe(false);
      expect(button("Quitting")).toBeTruthy();
      expect(unknownSwitch().props.accessibilityState?.disabled).toBe(false);
      await leave();
      expect(puts).toEqual([]);
    });

    it("stays gated when the person came back without an answer", async () => {
      await opened("hasKids", { fields: {} });
      await backInFront();
      expect(screen.getByText(GATED)).toBeTruthy();
    });

    it("takes nothing away when the read on the way back fails, and the next read counts", async () => {
      const { server } = await opened("smoking");
      await press(button("Never"));
      server.noProfile = true;
      await backInFront();
      expect(screen.queryByText(LOAD_FAILED)).toBeNull();
      expect(selected("Never")).toBe(true);
      server.noProfile = false;
      server.fields = {};
      await backInFront();
      // Its own answer gone meanwhile: what was chosen here is paused now, in words.
      expect(screen.getByText(PAUSED)).toBeTruthy();
    });
  });

  describe("a save refused", () => {
    const refused = async (code: string, status: number) => {
      const { server, puts, view } = await opened("smoking", {
        refusal: () => envelope(code, status),
      });
      await press(button("Never"));
      await leaveAndGo(view);
      expect(router.push).toHaveBeenCalledWith("/profile/deal-breakers/smoking");
      const again = await show(<DealBreakerFieldScreen field="smoking" />);
      await waitFor(() => expect(screen.getByText(THE_QUESTION)).toBeTruthy());
      return { server, puts, again };
    };

    it("brings the change back and says it could not be saved, and goes on the word", async () => {
      const { puts } = await refused("internal_error", 500);
      expect(selected("Never")).toBe(true);
      expect(screen.getByText(FAILED)).toBeTruthy();
      await press(button("Leave without saving"));
      expect(screen.queryByText(THE_QUESTION)).toBeNull();
      expect(router.back).toHaveBeenCalledTimes(1);
      await leave();
      expect(puts).toHaveLength(1);
    });

    it("says what is missing when the API asks for the own answer first", async () => {
      await refused("filter_unanswered", 409);
      expect(screen.getByText(GATED)).toBeTruthy();
      expect(screen.queryByText(FAILED)).toBeNull();
    });

    it("says it could not be saved when the number was lowered meanwhile", async () => {
      await refused("validation_failed", 400);
      expect(screen.getByText(FAILED)).toBeTruthy();
    });

    it("keeps the draft on Keep editing, and saves it on the next leaving", async () => {
      const { server, puts, again } = await refused("internal_error", 500);
      server.refusal = null;
      await press(button("Keep editing"));
      expect(screen.queryByText(THE_QUESTION)).toBeNull();
      expect(router.back).not.toHaveBeenCalled();
      await press(button("Quitting"));
      await leaveAndGo(again);
      const saved = { field: "smoking", includeUnknown: true };
      expect(puts).toEqual([
        [{ ...saved, accept: ["never"] }],
        [{ ...saved, accept: ["never", "quitting"] }],
      ]);
      expect(router.push).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["fi-FI", "Kaikki", "Ei koskaan", "Tallentaminen ei onnistunut. Yritä uudelleen."],
      ["sv-FI", "Alla", "Aldrig", "Det gick inte att spara. Försök igen."],
    ])("says in %s that it could not be saved", async (tag, everyone, never, failed) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
      try {
        fakeApi({ refusal: () => envelope("internal_error", 500) });
        const view = await show(<DealBreakerFieldScreen field="smoking" />);
        await waitFor(() => expect(button(everyone)).toBeTruthy());
        await press(button(never));
        await leaveAndGo(view);
        await show(<DealBreakerFieldScreen field="smoking" />);
        await waitFor(() => expect(screen.getByText(failed)).toBeTruthy());
      } finally {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
      }
    });

    describe("with its read lost too", () => {
      const broughtBack = async () => {
        const { server, puts, view } = await opened("smoking");
        await press(button("Never"));
        server.offline = true;
        await leaveAndGo(view);
        // The save reads the set first, so what the network lost never became a PUT.
        expect(puts).toEqual([]);
        const again = await show(<DealBreakerFieldScreen field="smoking" />);
        await waitFor(() => expect(screen.getByText(THE_QUESTION)).toBeTruthy());
        return { server, puts, again };
      };

      it("shows the change over the failure, and tries again on the leaving after Keep editing", async () => {
        const { server, puts, again } = await broughtBack();
        await press(button("Keep editing"));
        expect(screen.queryByText(LOAD_FAILED)).toBeNull();
        expect(selected("Never")).toBe(true);
        // Nothing known of the own answer, so nothing is held back: the draft can be changed.
        expect(disabled("Never")).toBe(false);
        expect(button("Quitting")).toBeTruthy();
        server.offline = false;
        await leaveAndGo(again);
        expect(puts).toEqual([[{ field: "smoking", accept: ["never"], includeUnknown: true }]]);
        expect(server.dealBreakers).toHaveLength(1);
      });

      it("tries taking one off again, with nothing read to compare Everyone with", async () => {
        const { server, puts, view } = await opened("smoking", { dealBreakers: [smoking] });
        await press(button(EVERYONE));
        server.offline = true;
        await leaveAndGo(view);
        const again = await show(<DealBreakerFieldScreen field="smoking" />);
        await waitFor(() => expect(screen.getByText(THE_QUESTION)).toBeTruthy());
        await press(button("Keep editing"));
        expect(selected(EVERYONE)).toBe(true);
        server.offline = false;
        await leaveAndGo(again);
        expect(puts).toEqual([[]]);
      });

      it("goes back on Leave without saving, and sends nothing", async () => {
        const { server, puts } = await broughtBack();
        server.offline = false;
        await press(button("Leave without saving"));
        expect(router.back).toHaveBeenCalledTimes(1);
        await leave();
        expect(puts).toEqual([]);
      });
    });
  });

  describe("reading", () => {
    it("says it is loading until both reads are in, in a live region, and leaving sends nothing", async () => {
      const { puts } = fakeApi({ wait: new Promise(() => {}) });
      await show(<DealBreakerFieldScreen field="smoking" />);
      expect(screen.getByText("Loading your profile…").props.accessibilityLiveRegion).toBe(
        "polite",
      );
      expect(screen.queryByRole("button", { name: EVERYONE })).toBeNull();
      await leave();
      expect(puts).toEqual([]);
    });

    it.each([
      ["the deal-breakers", { failing: true }],
      ["the person's own answers", { noProfile: true }],
    ])("says when %s could not be read, and tries again", async (_what, broken) => {
      const { server } = fakeApi(broken);
      await show(<DealBreakerFieldScreen field="smoking" />);
      await waitFor(() => expect(screen.getByText(LOAD_FAILED)).toBeTruthy());
      expect(
        screen.getByText("Kuutti's server had a problem. Try again in a moment."),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: EVERYONE })).toBeNull();
      checkA11y();
      server.failing = false;
      server.noProfile = false;
      await press(button("Try again"));
      await waitFor(() => expect(button(EVERYONE)).toBeTruthy());
      expect(screen.queryByText(LOAD_FAILED)).toBeNull();
    });

    it("says it is loading again while Try again reads", async () => {
      const { server } = fakeApi({ failing: true });
      await show(<DealBreakerFieldScreen field="smoking" />);
      await waitFor(() => expect(screen.getByText(LOAD_FAILED)).toBeTruthy());
      let answer: (() => void) | undefined;
      server.wait = new Promise((resolve) => {
        answer = resolve;
      });
      server.failing = false;
      await press(button("Try again"));
      expect(screen.getByText("Loading your profile…")).toBeTruthy();
      await act(async () => {
        answer?.();
        await settle();
      });
      await waitFor(() => expect(button(EVERYONE)).toBeTruthy());
    });

    it.each([
      ["a field no filter is offered on", "religion"],
      ["a word no field has", "nonsense"],
      ["the wrong case", "Smoking"],
      ["nothing at all", ""],
    ])("goes to the list from %s, showing nothing and saving nothing", async (_what, field) => {
      const { puts } = fakeApi();
      await show(<DealBreakerFieldScreen field={field} />);
      expect(router.replace).toHaveBeenCalledWith("/profile/deal-breakers");
      expect(screen.queryByText(EXPLAIN)).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
      await leave();
      expect(puts).toEqual([]);
    });
  });

  describe("the words", () => {
    it.each([
      ["smoking", ["Never", "Sometimes", "Regularly", "Quitting", "Vaping"]],
      ["hasKids", ["No kids", "Kids at home", "Kids living elsewhere"]],
      ["wantsKids", ["Wants kids", "Doesn't want kids", "Not sure"]],
      ["monogamy", ["Monogamous", "Non-monogamous"]],
    ])("say of %s what somebody else's answer is", async (field, words) => {
      await opened(field);
      expect(buttons()).toEqual(["Back", EVERYONE, ...words]);
    });

    it.each([
      [
        "fi-FI",
        "Tämä toimii molempiin suuntiin: se ratkaisee myös, ketkä näkevät sinut.",
        [
          ["smoking", "Tupakointi", "Kaikki", "Ei koskaan"],
          ["hasKids", "Lapset", "Kaikki", "Lapset asuvat muualla"],
          ["wantsKids", "Lapset tulevaisuudessa", "Kaikki", "Haluaa lapsia"],
        ],
      ],
      [
        "sv-FI",
        "Det här gäller åt båda håll: det avgör också vilka som ser dig.",
        [
          ["smoking", "Rökning", "Alla", "Aldrig"],
          ["hasKids", "Barn", "Alla", "Barn som bor annanstans"],
          ["wantsKids", "Barn i framtiden", "Alla", "Vill ha barn"],
        ],
      ],
    ])("speak %s", async (tag, explain, rows) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
      try {
        for (const [field, title, everyone, option] of rows as string[][]) {
          fakeApi();
          const view = await show(<DealBreakerFieldScreen field={field as string} />);
          await waitFor(() => expect(screen.getByText(explain as string)).toBeTruthy());
          expectPinnedHeader(title as string, tag === "fi-FI" ? "Takaisin" : "Tillbaka");
          expect(button(everyone as string)).toBeTruthy();
          expect(button(option as string)).toBeTruthy();
          await act(async () => {
            view.unmount();
            await settle();
          });
        }
      } finally {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
      }
    });
  });
});
