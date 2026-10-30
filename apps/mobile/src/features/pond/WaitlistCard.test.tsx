import type { PondSummary, WaitlistResponse } from "@kuutti/schema";
import { act, fireEvent } from "@testing-library/react-native";
import { renderWithTheme } from "@/test/render";
import { WaitlistCard } from "./WaitlistCard";

// The waitlist card (#54, ADR-013): figures in words, nothing below the
// threshold, and the bar of whom the people there seek (#507).

const POND: PondSummary = {
  id: "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01",
  slug: "otaniemi",
  name: "Otaniemi",
  nameInessive: "Otaniemessä",
  parentId: null,
};

const waitlist = (figures: Partial<WaitlistResponse["ponds"][number]>): WaitlistResponse => ({
  k: 10,
  ponds: [
    {
      pond: POND,
      day: figures.verified == null ? null : "2026-10-05",
      verified: null,
      split: null,
      finishing: null,
      ...figures,
    },
  ],
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const NO_BAR = () => json({ seeks: null });
const BAR = () => json({ seeks: { men: 30, everyone: 20, women: 50 } });

function answering(answers: Array<() => Response>, seeks: () => Response = NO_BAR) {
  const calls: Request[] = [];
  let n = 0;
  globalThis.fetch = jest.fn(async (input: Request | string) => {
    const request = input instanceof Request ? input : new Request(input);
    if (new URL(request.url).pathname === "/ponds/seeks") return seeks();
    calls.push(request);
    const answer = answers[Math.min(n, answers.length - 1)];
    n += 1;
    if (!answer) throw new Error("no answer prepared");
    return answer();
  }) as unknown as typeof fetch;
  return calls;
}

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

describe("WaitlistCard", () => {
  it("says the figures in words, with the pond's name on its own", async () => {
    const calls = answering([() => json(waitlist({ verified: 42, finishing: 17 }))], BAR);
    const screen = await renderWithTheme(<WaitlistCard pond={POND} />);
    await settle();
    expect(screen.getByLabelText("People in your area")).toBeTruthy();
    expect(screen.getByText("Otaniemi")).toBeTruthy();
    expect(screen.getByText("42 people have identified with their bank")).toBeTruthy();
    expect(screen.getByText("30 % men")).toBeTruthy();
    expect(screen.getByText("20 % everyone")).toBeTruthy();
    expect(screen.getByText("50 % women")).toBeTruthy();
    expect(screen.getByText("17 people are still finishing their profile.")).toBeTruthy();
    expect(
      screen.getByText(
        "The numbers change only when at least 10 people have joined or left, so that one person joining or leaving does not show.",
      ),
    ).toBeTruthy();
    // The public route: asked without the session's token.
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/waitlist");
    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("no longer says the gender split, even when the counter does", async () => {
    answering([
      () =>
        json(
          waitlist({ verified: 42, split: { woman: 20, man: 12, nonBinary: 10 }, finishing: 17 }),
        ),
    ]);
    const screen = await renderWithTheme(<WaitlistCard pond={POND} />);
    await settle();
    expect(screen.getByText("42 people have identified with their bank")).toBeTruthy();
    expect(screen.queryByText(/non-binary/)).toBeNull();
  });

  it("draws no bar while the pond may not say it, or when its read fails", async () => {
    answering([() => json(waitlist({ verified: 30, finishing: 0 }))]);
    const quiet = await renderWithTheme(<WaitlistCard pond={POND} />);
    await settle();
    expect(quiet.getByText("30 people have identified with their bank")).toBeTruthy();
    expect(quiet.queryByRole("image")).toBeNull();
    await quiet.rerender(<></>);

    answering([() => json(waitlist({ verified: 30, finishing: 0 }))], () =>
      json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
    );
    const failed = await renderWithTheme(<WaitlistCard pond={POND} />);
    await settle();
    expect(failed.getByText("30 people have identified with their bank")).toBeTruthy();
    expect(failed.queryByRole("image")).toBeNull();
    expect(failed.queryByText("The numbers could not be read.")).toBeNull();
  });

  it("draws no bar below the threshold, whatever the bar's route says", async () => {
    answering([() => json(waitlist({}))], BAR);
    const screen = await renderWithTheme(<WaitlistCard pond={POND} />);
    await settle();
    expect(screen.queryByRole("image")).toBeNull();
  });

  it("says no number about a pond below the threshold", async () => {
    answering([() => json(waitlist({}))]);
    const screen = await renderWithTheme(<WaitlistCard pond={POND} />);
    await settle();
    expect(
      screen.getByText(
        "Your area is just getting started. Numbers are shown only when at least 10 people are here.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/identified with their bank/)).toBeNull();
    expect(screen.queryByText(/finishing their profile/)).toBeNull();
    expect(screen.queryByText(/joined or left/)).toBeNull();
  });

  it("has words for nobody finishing", async () => {
    answering([() => json(waitlist({ verified: 30, split: null, finishing: 0 }))]);
    const screen = await renderWithTheme(<WaitlistCard pond={POND} />);
    await settle();
    expect(screen.getByText("30 people have identified with their bank")).toBeTruthy();
    expect(screen.getByText("Everyone has finished their profile.")).toBeTruthy();
  });

  it("says nothing of people finishing when the counter hides their number", async () => {
    answering([() => json(waitlist({ verified: 12, split: null, finishing: null }))]);
    const screen = await renderWithTheme(<WaitlistCard pond={POND} />);
    await settle();
    expect(screen.getByText("12 people have identified with their bank")).toBeTruthy();
    expect(screen.queryByText(/finish/)).toBeNull();
  });

  it("offers another try when the figures cannot be read", async () => {
    answering([
      () => json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
      () => json(waitlist({ verified: 11, split: null, finishing: 11 })),
    ]);
    const screen = await renderWithTheme(<WaitlistCard pond={POND} />);
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
