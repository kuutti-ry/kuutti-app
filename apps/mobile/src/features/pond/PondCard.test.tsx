import type { PondCounterResponse, PondSummary } from "@kuutti/schema";
import { act, fireEvent } from "@testing-library/react-native";
import { FAILED_TO_LOAD } from "@/test/failed";
import { renderWithTheme } from "@/test/render";
import { PondCard } from "./PondCard";

// The pond card (#54, #581, ADR-013): the number in one sentence, none below the
// threshold, the bar of whom those people seek right under it (#507), and not a
// word that a profile can be unfinished.

const POND: PondSummary = {
  id: "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01",
  slug: "suomi",
  name: "Suomi",
};

const counter = (figures: Partial<PondCounterResponse["ponds"][number]>): PondCounterResponse => ({
  k: 10,
  ponds: [
    {
      pond: POND,
      day: figures.finished == null ? null : "2026-10-05",
      finished: null,
      seeks: null,
      ...figures,
    },
  ],
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const BAR = { men: 30, everyone: 20, women: 50 };
const HEADING = "People on Kuutti";
const SMALL = "Kuutti is just getting started.";

function answering(answers: Array<() => Response>) {
  const calls: Request[] = [];
  let n = 0;
  globalThis.fetch = jest.fn(async (input: Request | string) => {
    const request = input instanceof Request ? input : new Request(input);
    calls.push(request);
    const answer = answers[Math.min(n, answers.length - 1)];
    n += 1;
    if (!answer) throw new Error("no answer prepared");
    return answer();
  }) as unknown as typeof fetch;
  return calls;
}

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

/** The card as it stands once the answer is in, and every line it holds, hidden or not, in order. */
async function cardAnswering(body: PondCounterResponse) {
  answering([() => json(body)]);
  const screen = await renderWithTheme(<PondCard />);
  await settle();
  const lines = screen
    .getAllByText(/./, { includeHiddenElements: true })
    .map((node) => node.props.children);
  return { screen, lines };
}

describe("PondCard", () => {
  it("says the number in one sentence under one heading that names no area, and the bar right under it", async () => {
    const calls = answering([() => json(counter({ finished: 477, seeks: BAR }))]);
    const screen = await renderWithTheme(<PondCard />);
    await settle();
    expect(screen.getByLabelText(HEADING)).toBeTruthy();
    expect(screen.getByText(HEADING)).toBeTruthy();
    const sentence = screen.getByText(
      "477 people have completed their profiles and are looking for:",
    );
    const siblings = sentence.parent?.children ?? [];
    const next = siblings[siblings.indexOf(sentence) + 1];
    expect(typeof next === "object" && next.props.accessibilityRole).toBe("image");
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/ponds/counter");
  });

  it("says nothing but the heading, the sentence and the bar's labels while it has a bar", async () => {
    const { lines } = await cardAnswering(counter({ finished: 477, seeks: BAR }));
    expect(lines).toEqual([
      HEADING,
      "477 people have completed their profiles and are looking for:",
      "30 % men",
      "20 % everyone",
      "50 % women",
    ]);
  });

  it("ends the sentence where there is no bar to lead into, and draws none", async () => {
    const { screen, lines } = await cardAnswering(counter({ finished: 30 }));
    expect(lines).toEqual([HEADING, "30 people have completed their profiles."]);
    expect(screen.queryByRole("image")).toBeNull();
  });

  it("says only that Kuutti is getting started below the threshold, with no number and no condition", async () => {
    const { screen, lines } = await cardAnswering(counter({}));
    expect(lines).toEqual([HEADING, SMALL]);
    expect(screen.queryByRole("image")).toBeNull();
  });

  it("says the same of a counter that lists no pond", async () => {
    const { screen, lines } = await cardAnswering({ k: 10, ponds: [] });
    expect(lines).toEqual([HEADING, SMALL]);
    expect(screen.queryByRole("image")).toBeNull();
  });

  it("draws no bar below the threshold, whatever the answer says", async () => {
    const { screen, lines } = await cardAnswering(counter({ seeks: BAR }));
    expect(lines).toEqual([HEADING, SMALL]);
    expect(screen.queryByRole("image")).toBeNull();
  });

  it("gives a screen reader no word of a profile that is not complete either", async () => {
    const { screen } = await cardAnswering(counter({ finished: 477, seeks: BAR }));
    expect(screen.getByRole("image").props.accessibilityLabel).toBe(
      "Of the people with a finished profile who are looking for men or women, 30 percent are looking for men. 20 percent are looking for everyone. 50 percent are looking for women.",
    );
    expect(screen.queryByLabelText(/finishing|unfinished|not complete|incomplete/i)).toBeNull();
  });

  it("brings the bar back with the number on Try again", async () => {
    answering([
      () => json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
      () => json(counter({ finished: 30, seeks: BAR })),
    ]);
    const screen = await renderWithTheme(<PondCard />);
    await settle();
    expect(screen.getByText(FAILED_TO_LOAD)).toBeTruthy();
    expect(screen.queryByRole("image")).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Try again" }));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
    await settle();
    expect(
      screen.getByText("30 people have completed their profiles and are looking for:"),
    ).toBeTruthy();
    expect(screen.getByText("30 % men")).toBeTruthy();
  });

  it("offers the update and no number when the answer has the shape before the one number", async () => {
    const before = {
      pond: POND,
      day: "2026-10-05",
      verified: 42,
      split: null,
      finishing: 17,
      seeks: null,
    };
    answering([() => json({ k: 10, ponds: [before] })]);
    const screen = await renderWithTheme(<PondCard />);
    await settle();
    expect(screen.getByText(FAILED_TO_LOAD)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update the app" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByText(/42/)).toBeNull();
  });

  it("offers another try when the figures cannot be read", async () => {
    answering([
      () => json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
      () => json(counter({ finished: 11 })),
    ]);
    const screen = await renderWithTheme(<PondCard />);
    await settle();
    expect(screen.getByText(FAILED_TO_LOAD)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry.props.accessibilityRole).toBe("button");
    await act(async () => {
      fireEvent.press(retry);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
    await settle();
    expect(screen.getByText("11 people have completed their profiles.")).toBeTruthy();
    expect(screen.queryByText(FAILED_TO_LOAD)).toBeNull();
  });
});
