import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import type * as React from "react";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { DealBreakersScreen } from "./DealBreakersScreen";

const { __router: router, __navigation: navigation } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock };
  __navigation: {
    dispatch: jest.Mock;
    setOptions: jest.Mock;
    emit: (name: string, event: unknown) => void;
  };
};
const settle = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The arrow, Android's back key or a pop of several screens, as the stack reports it. */
const leave = async () => {
  const event = { preventDefault: jest.fn(), data: { action: { type: "GO_BACK" } } };
  await act(async () => {
    navigation.emit("beforeRemove", event);
    await settle();
  });
  return event;
};
const swipe = () => navigation.setOptions.mock.lastCall?.[0];
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
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);

type DealBreaker = { field: string; accept: string[]; includeUnknown: boolean };

/** A tiny server: the profile for the own answers, the deal-breakers read and replaced whole, paused read off the profile. */
function fakeApi(fields: Record<string, unknown>, dealBreakers: DealBreaker[] = [], max = 2) {
  const server = { fields, dealBreakers };
  const puts: DealBreaker[][] = [];
  const stored = () => ({
    dealBreakers: server.dealBreakers.map((d) => ({
      ...d,
      paused: server.fields[d.field] === undefined,
    })),
    max,
  });
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/profile" && request.method === "GET") {
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
      });
    }
    if (path === "/preferences/deal-breakers" && request.method === "GET") return json(stored());
    if (path === "/preferences/deal-breakers" && request.method === "PUT") {
      const body = (await request.json()) as { dealBreakers: DealBreaker[] };
      puts.push(body.dealBreakers);
      server.dealBreakers = body.dealBreakers;
      return json(stored());
    }
    return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
  }) as unknown as typeof fetch;
  return { server, puts };
}

const answeredAll = {
  monogamy: "monogamous",
  hasKids: "no",
  wantsKids: "want",
  smoking: "never",
  languages: ["fi"],
  height: 170,
};

const checkA11y = () => {
  const found = pressables(screen.toJSON() as HostNode);
  expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
};

beforeEach(async () => {
  router.push.mockReset();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("DealBreakersScreen", () => {
  it("gates a field the person has not answered and leads to its screen", async () => {
    fakeApi({ ...answeredAll, hasKids: undefined });
    await show(<DealBreakersScreen />);
    await waitFor(() => expect(screen.getByText("Deal-breakers")).toBeTruthy());
    expect(screen.getByText(/Up to 2\./)).toBeTruthy();
    // Four switches for the answered lists, height has buttons; kids ask for the answer first.
    expect(screen.getAllByRole("switch")).toHaveLength(4);
    expect(screen.queryByLabelText("Deal-breaker: Kids")).toBeNull();
    expect(screen.getAllByText("To filter on this, share yours first.")).toHaveLength(1);
    checkA11y();
    await press(screen.getByRole("button", { name: "Answer it" }));
    expect(router.push).toHaveBeenCalledWith("/profile/later/hasKids");
  });

  it("goes back to where it was opened from an arrow pinned above the list, saving nothing", async () => {
    const { puts } = fakeApi(answeredAll);
    router.back.mockClear();
    await show(<DealBreakersScreen />);
    await waitFor(() => expect(screen.getByText("Deal-breakers")).toBeTruthy());
    expectPinnedHeader("Deal-breakers", "Back");
    await press(screen.getAllByRole("switch")[0] as ReturnType<typeof screen.getByRole>);
    await press(screen.getByRole("button", { name: "Back" }));
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(puts).toEqual([]);
  });

  it("asks before switches changed and not saved are left, and leaves only on the word", async () => {
    const { puts } = fakeApi(answeredAll);
    navigation.dispatch.mockClear();
    await show(<DealBreakersScreen />);
    await waitFor(() => expect(screen.getByText("Deal-breakers")).toBeTruthy());
    expect(swipe()).toEqual({ gestureEnabled: true });
    await press(screen.getByLabelText("Deal-breaker: Smoking"));
    // The iOS swipe cannot be held without bouncing (#238), so it is off while something is unsaved.
    expect(swipe()).toEqual({ gestureEnabled: false });

    const first = await leave();
    expect(first.preventDefault).toHaveBeenCalled();
    expect(screen.getByText("Leave without saving?")).toBeTruthy();
    expect(screen.getByText("Your changes are not saved yet.")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText("Leave without saving?")).toBeNull();
    expect(navigation.dispatch).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Deal-breaker: Smoking").props.accessibilityState?.checked).toBe(
      true,
    );

    await leave();
    await press(screen.getByRole("button", { name: "Leave without saving" }));
    expect(navigation.dispatch).toHaveBeenCalledWith({ type: "GO_BACK" });
    expect(puts).toEqual([]);
    // Dropped: back to what is stored, so a screen a link left mounted holds nothing.
    expect(screen.getByLabelText("Deal-breaker: Smoking").props.accessibilityState?.checked).toBe(
      false,
    );
  });

  it("lets go at once when nothing changed, and once the changes are saved", async () => {
    fakeApi(answeredAll);
    await show(<DealBreakersScreen />);
    await waitFor(() => expect(screen.getByText("Deal-breakers")).toBeTruthy());
    expect((await leave()).preventDefault).not.toHaveBeenCalled();

    await press(screen.getByLabelText("Deal-breaker: Smoking"));
    await press(screen.getByRole("button", { name: "Never" }));
    // Switched off again: the same set as stored, so nothing to lose.
    await press(screen.getByLabelText("Deal-breaker: Smoking"));
    expect((await leave()).preventDefault).not.toHaveBeenCalled();

    await press(screen.getByLabelText("Deal-breaker: Smoking"));
    await press(screen.getByRole("button", { name: "Save the deal-breakers" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    expect(swipe()).toEqual({ gestureEnabled: true });
    expect((await leave()).preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByText("Leave without saving?")).toBeNull();
  });

  it("leads a field without a later screen to the section that holds it (#239)", async () => {
    fakeApi({ ...answeredAll, monogamy: undefined });
    await show(<DealBreakersScreen />);
    await waitFor(() => expect(screen.getByText("Deal-breakers")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Answer it" }));
    expect(router.push).toHaveBeenCalledWith("/profile/section/relationship");
  });

  it("switches deal-breakers on, takes what is fine, holds the limit, and saves the set", async () => {
    const { puts } = fakeApi(answeredAll);
    await show(<DealBreakersScreen />);
    await waitFor(() => expect(screen.getByText("Deal-breakers")).toBeTruthy());
    await press(screen.getByLabelText("Deal-breaker: Smoking"));
    expect(screen.getByText("Pick at least one answer that is fine with you.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Save the deal-breakers" }).props.accessibilityState
        ?.disabled,
    ).toBe(true);
    await press(screen.getByRole("button", { name: "Never" }));
    await press(screen.getByRole("button", { name: "Quitting" }));
    // On from the start (ADR-042 §8), switched off here.
    expect(
      screen.getByLabelText("Also people who did not answer").props.accessibilityState?.checked,
    ).toBe(true);
    await press(screen.getByLabelText("Also people who did not answer"));
    await press(screen.getByLabelText("Deal-breaker: Kids"));
    await press(screen.getByRole("button", { name: "No kids" }));
    checkA11y();
    // A third one: refused in words, and the switch stays off.
    await press(screen.getByLabelText("Deal-breaker: Relationship structure"));
    expect(screen.getByText("That is 2 already.")).toBeTruthy();
    expect(
      screen.getByLabelText("Deal-breaker: Relationship structure").props.accessibilityState
        ?.checked,
    ).toBe(false);
    await press(screen.getByRole("button", { name: "Save the deal-breakers" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    // A new deal-breaker lets through who did not answer until switched off (ADR-042 §8): smoking's was.
    expect(puts).toEqual([
      [
        { field: "hasKids", accept: ["no"], includeUnknown: true },
        { field: "smoking", accept: ["never", "quitting"], includeUnknown: false },
      ],
    ]);
  });

  it("says in words that a deal-breaker is paused while the own answer is missing", async () => {
    fakeApi({ ...answeredAll, smoking: undefined }, [
      { field: "smoking", accept: ["never"], includeUnknown: false },
    ]);
    await show(<DealBreakersScreen />);
    await waitFor(() =>
      expect(screen.getByText("Paused until you answer it yourself.")).toBeTruthy(),
    );
    expect(screen.getByLabelText("Deal-breaker: Smoking").props.accessibilityState?.checked).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Never" }).props.accessibilityState?.selected).toBe(
      true,
    );
    await press(screen.getByRole("button", { name: "Answer it" }));
    expect(router.push).toHaveBeenCalledWith("/profile/later/smoking");
  });

  describe("the height row (#508)", () => {
    const button = (name: string) => screen.getByRole("button", { name });
    const selected = (name: string) => button(name).props.accessibilityState?.selected;
    const ready = async () => {
      await show(<DealBreakersScreen />);
      await waitFor(() => expect(screen.getByText("Deal-breakers")).toBeTruthy());
    };

    it("has four buttons where a list has its switch, with Everyone chosen", async () => {
      fakeApi(answeredAll);
      await ready();
      expect(screen.queryByLabelText("Deal-breaker: Height")).toBeNull();
      expect(selected("Everyone")).toBe(true);
      for (const name of ["Taller than me", "My height or taller", "Shorter than me"]) {
        expect(selected(name)).toBe(false);
      }
      // Nothing to say of those who did not answer until a relation is chosen, and no heading of
      // answers that are fine: the buttons are the sentence.
      expect(screen.queryByLabelText("Also people who did not answer")).toBeNull();
      expect(screen.queryByText("Fine with me")).toBeNull();
      checkA11y();
    });

    it("takes one relation at a time, saves it, and Everyone takes it off", async () => {
      const { puts } = fakeApi(answeredAll);
      await ready();
      await press(button("Taller than me"));
      expect(selected("Taller than me")).toBe(true);
      expect(selected("Everyone")).toBe(false);
      // On from the start (ADR-042 §8), as with every deal-breaker.
      expect(
        screen.getByLabelText("Also people who did not answer").props.accessibilityState?.checked,
      ).toBe(true);
      checkA11y();

      await press(button("Shorter than me"));
      expect(selected("Taller than me")).toBe(false);
      expect(selected("Shorter than me")).toBe(true);
      await press(button("Save the deal-breakers"));
      await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());

      await press(button("Everyone"));
      expect(selected("Everyone")).toBe(true);
      expect(selected("Shorter than me")).toBe(false);
      expect(screen.queryByLabelText("Also people who did not answer")).toBeNull();
      await press(button("Save the deal-breakers"));
      await waitFor(() => expect(puts).toHaveLength(2));
      expect(puts).toEqual([[{ field: "height", accept: ["shorter"], includeUnknown: true }], []]);
    });

    it("shows a stored relation and sends its switch back", async () => {
      const { puts } = fakeApi(answeredAll, [
        { field: "height", accept: ["at_least_mine"], includeUnknown: false },
      ]);
      await ready();
      expect(selected("My height or taller")).toBe(true);
      expect(selected("Everyone")).toBe(false);
      expect(
        screen.getByLabelText("Also people who did not answer").props.accessibilityState?.checked,
      ).toBe(false);
      await press(button("Taller than me"));
      await press(button("Save the deal-breakers"));
      await waitFor(() => expect(puts).toHaveLength(1));
      expect(puts[0]).toEqual([{ field: "height", accept: ["taller"], includeUnknown: false }]);
    });

    it("counts a first relation against the limit", async () => {
      fakeApi(answeredAll, [{ field: "smoking", accept: ["never"], includeUnknown: false }], 1);
      await ready();
      await press(button("Taller than me"));
      expect(screen.getByText("That is 1 already.")).toBeTruthy();
      expect(selected("Everyone")).toBe(true);
      expect(selected("Taller than me")).toBe(false);
    });

    it("never counts a change of relation against the limit", async () => {
      fakeApi(answeredAll, [{ field: "height", accept: ["taller"], includeUnknown: true }], 1);
      await ready();
      await press(button("Shorter than me"));
      expect(screen.queryByText("That is 1 already.")).toBeNull();
      expect(selected("Shorter than me")).toBe(true);
    });

    it("asks for the person's own height first, and leads to its screen", async () => {
      fakeApi({ ...answeredAll, height: undefined });
      await ready();
      expect(screen.getByText("To filter on this, share yours first.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Taller than me" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Everyone" })).toBeNull();
      await press(button("Answer it"));
      expect(router.push).toHaveBeenCalledWith("/profile/later/height");
    });

    it("says in words that it is paused while the own height is missing, and can be taken off", async () => {
      const { puts } = fakeApi({ ...answeredAll, height: undefined }, [
        { field: "height", accept: ["taller"], includeUnknown: true },
      ]);
      await ready();
      expect(screen.getByText("Paused until you answer it yourself.")).toBeTruthy();
      expect(selected("Taller than me")).toBe(true);
      await press(button("Everyone"));
      await press(button("Save the deal-breakers"));
      await waitFor(() => expect(puts).toEqual([[]]));
    });
  });

  it("says when the deal-breakers could not be read, and tries again", async () => {
    globalThis.fetch = jest.fn(async () =>
      json({ error: { code: "x", message: "no", requestId: "r" } }, 500),
    ) as unknown as typeof fetch;
    await show(<DealBreakersScreen />);
    await waitFor(() => expect(screen.getByText("Your profile could not be loaded.")).toBeTruthy());
    fakeApi(answeredAll);
    await press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Deal-breakers")).toBeTruthy());
  });

  it("searches a long list of answers it accepts", async () => {
    fakeApi(answeredAll);
    await show(<DealBreakersScreen />);
    await waitFor(() => expect(screen.getByText("Deal-breakers")).toBeTruthy());
    await press(screen.getByLabelText("Deal-breaker: Languages"));
    expect(screen.getByRole("button", { name: "Finnish" })).toBeTruthy();
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("Search"), " GERM ");
      await settle();
    });
    expect(screen.getByRole("button", { name: "German" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Finnish" })).toBeNull();
    expect(screen.getByLabelText("Search").props.value).toBe(" GERM ");
  });

  it("leads the accepted languages with the first ten, as their picker does, and keeps an accepted one in view (#239)", async () => {
    fakeApi(answeredAll, [{ field: "languages", accept: ["fi", "de"], includeUnknown: false }]);
    await show(<DealBreakersScreen />);
    await waitFor(() => expect(screen.getByText("Deal-breakers")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Somali" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "German" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Another language" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "French" })).toBeNull();
    // Taken back, an accepted language beyond the ten stays to be accepted again.
    await press(screen.getByRole("button", { name: "German" }));
    expect(screen.getByRole("button", { name: "German" }).props.accessibilityState?.selected).toBe(
      false,
    );
    await press(screen.getByRole("button", { name: "German" }));
    expect(screen.getByRole("button", { name: "German" }).props.accessibilityState?.selected).toBe(
      true,
    );
  });

  it("takes an accepted answer back, and switches a deal-breaker off again", async () => {
    const { puts } = fakeApi(answeredAll, [
      { field: "smoking", accept: ["never", "quitting"], includeUnknown: false },
    ]);
    await show(<DealBreakersScreen />);
    await waitFor(() => expect(screen.getByText("Deal-breakers")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Quitting" }));
    expect(
      screen.getByRole("button", { name: "Quitting" }).props.accessibilityState?.selected,
    ).toBe(false);
    await press(screen.getByLabelText("Deal-breaker: Smoking"));
    expect(screen.queryByRole("button", { name: "Never" })).toBeNull();
    await press(screen.getByRole("button", { name: "Save the deal-breakers" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    expect(puts).toEqual([[]]);
  });

  it("says it is saving, and that the set could not be saved when the API refuses it", async () => {
    fakeApi(answeredAll);
    const reads = globalThis.fetch;
    let answer: ((response: Response) => void) | undefined;
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "PUT") {
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      }
      return reads(input, init);
    }) as unknown as typeof fetch;
    await show(<DealBreakersScreen />);
    await waitFor(() => expect(screen.getByText("Deal-breakers")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Save the deal-breakers" }));
    expect(screen.getByText("Saving…")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Save the deal-breakers" }).props.accessibilityState
        ?.disabled,
    ).toBe(true);
    await act(async () => {
      answer?.(json({ error: { code: "deal_breakers_limit", message: "x", requestId: "r" } }, 422));
      await settle();
    });
    expect(screen.getByText("They could not be saved. Try again.")).toBeTruthy();
    expect(screen.queryByText("Saving…")).toBeNull();
  });
});
