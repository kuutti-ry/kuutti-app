import type { PondCounterResponse, PondSummary } from "@kuutti/schema";
import { act, fireEvent } from "@testing-library/react-native";
import { renderWithTheme } from "@/test/render";
import { PondCard } from "./PondCard";

// The pond card (#54, ADR-013): figures in words, nothing below the
// threshold, and the bar of whom those people seek (#507).

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
      day: figures.verified == null ? null : "2026-10-05",
      verified: null,
      split: null,
      finishing: null,
      seeks: null,
      ...figures,
    },
  ],
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const BAR = { men: 30, everyone: 20, women: 50 };

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

describe("PondCard", () => {
  it("says the figures in words, under one heading that names no area", async () => {
    const calls = answering([() => json(counter({ verified: 42, finishing: 17, seeks: BAR }))]);
    const screen = await renderWithTheme(<PondCard />);
    await settle();
    expect(screen.getByLabelText("People on Kuutti")).toBeTruthy();
    expect(screen.getByText("People on Kuutti")).toBeTruthy();
    expect(screen.queryByText("Your area")).toBeNull();
    expect(screen.queryByText("Finland")).toBeNull();
    expect(screen.getByText("42 people have identified with their bank")).toBeTruthy();
    expect(screen.getByText("30 % men")).toBeTruthy();
    expect(screen.getByText("20 % everyone")).toBeTruthy();
    expect(screen.getByText("50 % women")).toBeTruthy();
    expect(screen.getByText("17 people are still finishing their profile.")).toBeTruthy();
    expect(
      screen.getByText(
        "The numbers change only in steps of at least 10 people, so that one person does not show.",
      ),
    ).toBeTruthy();
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/ponds/counter");
  });

  it("no longer says the gender split, even when the counter does", async () => {
    answering([
      () =>
        json(
          counter({ verified: 42, split: { woman: 20, man: 12, nonBinary: 10 }, finishing: 17 }),
        ),
    ]);
    const screen = await renderWithTheme(<PondCard />);
    await settle();
    expect(screen.getByText("42 people have identified with their bank")).toBeTruthy();
    expect(screen.queryByText(/non-binary/)).toBeNull();
  });

  it("draws no bar while the pond may not say it", async () => {
    answering([() => json(counter({ verified: 30, finishing: 0 }))]);
    const screen = await renderWithTheme(<PondCard />);
    await settle();
    expect(screen.getByText("30 people have identified with their bank")).toBeTruthy();
    expect(screen.queryByRole("image")).toBeNull();
  });

  it("brings the bar back with the figures on Try again", async () => {
    answering([
      () => json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
      () => json(counter({ verified: 30, finishing: 0, seeks: BAR })),
    ]);
    const screen = await renderWithTheme(<PondCard />);
    await settle();
    expect(screen.getByText("The numbers could not be read.")).toBeTruthy();
    expect(screen.queryByRole("image")).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Try again" }));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
    await settle();
    expect(screen.getByText("30 people have identified with their bank")).toBeTruthy();
    expect(screen.getByText("30 % men")).toBeTruthy();
  });

  it("draws no bar below the threshold, whatever the answer says", async () => {
    answering([() => json(counter({ seeks: BAR }))]);
    const screen = await renderWithTheme(<PondCard />);
    await settle();
    expect(screen.queryByRole("image")).toBeNull();
  });

  it("says no number about a pond below the threshold", async () => {
    answering([() => json(counter({}))]);
    const screen = await renderWithTheme(<PondCard />);
    await settle();
    expect(
      screen.getByText(
        "Kuutti is just getting started. Numbers are shown only when at least 10 people are here.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/identified with their bank/)).toBeNull();
    expect(screen.queryByText(/finishing their profile/)).toBeNull();
    expect(screen.queryByText(/in steps of/)).toBeNull();
  });

  it("has words for nobody finishing", async () => {
    answering([() => json(counter({ verified: 30, split: null, finishing: 0 }))]);
    const screen = await renderWithTheme(<PondCard />);
    await settle();
    expect(screen.getByText("30 people have identified with their bank")).toBeTruthy();
    expect(screen.getByText("Everyone has finished their profile.")).toBeTruthy();
  });

  it("says nothing of people finishing when the counter hides their number", async () => {
    answering([() => json(counter({ verified: 12, split: null, finishing: null }))]);
    const screen = await renderWithTheme(<PondCard />);
    await settle();
    expect(screen.getByText("12 people have identified with their bank")).toBeTruthy();
    expect(screen.queryByText(/finish/)).toBeNull();
  });

  it("offers another try when the figures cannot be read", async () => {
    answering([
      () => json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
      () => json(counter({ verified: 11, split: null, finishing: 11 })),
    ]);
    const screen = await renderWithTheme(<PondCard />);
    await settle();
    expect(screen.getByText("The numbers could not be read.")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry.props.accessibilityRole).toBe("button");
    await act(async () => {
      fireEvent.press(retry);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
    await settle();
    expect(screen.getByText("11 people have identified with their bank")).toBeTruthy();
    expect(screen.getByText("11 people are still finishing their profile.")).toBeTruthy();
  });
});
