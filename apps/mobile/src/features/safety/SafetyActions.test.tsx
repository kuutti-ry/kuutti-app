import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { useState } from "react";
import { AccessibilityInfo, Platform } from "react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { SafetyActions } from "./SafetyActions";

// Block or report from someone else's card (#84, ADR-030 §11): a labelled
// button, one dialog, a block only after words that say it is final, a report
// with one of #106's reasons that blocks too, the card handed back once the
// dialog closes, and the day's cap, a failure, a card gone and a slow answer
// each said in words, on iOS aloud too, with nothing typed lost to anything
// but Cancel.

const SUBJECT = "0c2d2d5f-0b9f-4b1b-8d4b-1d9e2f3a4b5c";
const NOTE_LABEL = "Anything the moderators should know (optional, up to 500 characters)";
const ALSO_BLOCKS =
  "A report also blocks them, for good: you will not see each other here again, even if either of you deletes their account. A block cannot be undone. They are not told.";
const CAP =
  "That is enough reports for today. You can still block this person, but then you cannot report them later.";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

type Sent = { path: string; body: unknown };
/** The API as the dialog sees it: every block and report recorded, answered as told. */
function api(answer: (path: string) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && (path === "/blocks" || path === "/reports")) {
      sent.push({ path, body: JSON.parse(await request.text()) });
      return answer(path);
    }
    return refusal("not_found", 404);
  }) as unknown as typeof fetch;
  return sent;
}
const done = () => new Response(null, { status: 204 });

/** The card's part: it holds the dialog open, as ProfileCardView does. */
function Host({ onGone }: { onGone: (accountId: string) => void }) {
  const [open, setOpen] = useState(false);
  return <SafetyActions accountId={SUBJECT} open={open} onOpenChange={setOpen} onGone={onGone} />;
}
const show = async (onGone: (accountId: string) => void = jest.fn()) => {
  await renderWithTheme(<Host onGone={onGone} />);
};
const press = (name: string | RegExp, role: "button" | "radio" = "button") =>
  act(async () => {
    fireEvent.press(screen.getByRole(role, { name }));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  });
/** The dialog's Done, after an outcome; the corner's control is Close, a name of its own. */
const pressDone = () => press("Done");
/** A tap on the dimmed screen around the dialog: the scrim, which is no accessibility element. */
const pressScrim = () =>
  act(async () => {
    const [scrim] = screen.container.queryAll((node) => node.props.accessible === false);
    fireEvent.press(scrim as never);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  });
const type = (words: string) =>
  act(async () => {
    fireEvent.changeText(screen.getByLabelText(NOTE_LABEL), words);
  });
const disabled = (name: string) =>
  screen.getByRole("button", { name }).props.accessibilityState?.disabled === true;
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);

const announced = () =>
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mock.calls.map(([words]) => words);

beforeEach(() => {
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
  (AccessibilityInfo.sendAccessibilityEvent as jest.Mock).mockClear();
});
// A platform a test chose is that test's alone, whether it passed or not.
afterEach(() => jest.restoreAllMocks());

describe("SafetyActions", () => {
  it("opens from its labelled button with Block and Report and block in words, and sends nothing before a choice", async () => {
    const sent = api(done);
    const gone = jest.fn();
    await show(gone);
    noProblems();
    await press("Block or report");
    expect(screen.getByText("Block or report")).toBeTruthy();
    expect(screen.getByText("You will not see each other again. They are not told.")).toBeTruthy();
    expect(
      screen.getByText(
        "Tell the moderators what is wrong. This blocks them too. They are not told who reported them.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Block" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Report and block" })).toBeTruthy();
    noProblems();
    await press("Cancel");
    expect(screen.queryByText("Block or report")).toBeNull();
    expect(sent).toEqual([]);
    expect(gone).not.toHaveBeenCalled();
  });

  it("blocks only after words that say it is final, and hands the card back once the dialog closes", async () => {
    const sent = api(done);
    const gone = jest.fn();
    await show(gone);
    await press("Block or report");
    await press("Block");
    expect(screen.getByText("Block this person?")).toBeTruthy();
    expect(
      screen.getByText(
        "You will not see each other here again, even if either of you deletes their account and comes back. A block cannot be undone. They are not told.",
      ),
    ).toBeTruthy();
    expect(sent).toEqual([]);
    noProblems();
    await press("Block");
    await waitFor(() =>
      expect(screen.getByText("Blocked. You will not see each other again.")).toBeTruthy(),
    );
    expect(sent).toEqual([{ path: "/blocks", body: { accountId: SUBJECT } }]);
    // The card stays until the person has read what happened.
    expect(gone).not.toHaveBeenCalled();
    noProblems();
    await pressDone();
    expect(gone).toHaveBeenCalledWith(SUBJECT);
    expect(screen.queryByText("Blocked. You will not see each other again.")).toBeNull();
  });

  it("hands the card back when the dialog is closed from its corner after a block, and names the two controls apart", async () => {
    api(done);
    const gone = jest.fn();
    await show(gone);
    await press("Block or report");
    await press("Block");
    await press("Block");
    await screen.findByText("Blocked. You will not see each other again.");
    // One Close and one Done: a screen reader's list of buttons tells them apart.
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Done" })).toHaveLength(1);
    await press("Close");
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("cancels a block at its confirmation with nothing sent, and opens at the choice again", async () => {
    const sent = api(done);
    const gone = jest.fn();
    await show(gone);
    await press("Block or report");
    await press("Block");
    await press("Cancel");
    expect(screen.queryByText("Block this person?")).toBeNull();
    await press("Block or report");
    expect(screen.getByRole("button", { name: "Report and block" })).toBeTruthy();
    expect(sent).toEqual([]);
    expect(gone).not.toHaveBeenCalled();
  });

  it("keeps the confirmation open and says so when a block fails, and the second try goes through", async () => {
    let answer: () => Response | Promise<Response> = () => refusal("internal_error", 500);
    const sent = api(() => answer());
    await show();
    await press("Block or report");
    await press("Block");
    await press("Block");
    expect(await screen.findByText("The block did not go through. Try again.")).toBeTruthy();
    expect(screen.getByText("Block this person?")).toBeTruthy();
    // No connection at all reads the same.
    answer = () => Promise.reject(new TypeError("Network request failed"));
    await press("Block");
    expect(screen.getByText("The block did not go through. Try again.")).toBeTruthy();
    answer = done;
    await press("Block");
    expect(await screen.findByText("Blocked. You will not see each other again.")).toBeTruthy();
    expect(screen.queryByText("The block did not go through. Try again.")).toBeNull();
    expect(sent).toHaveLength(3);
  });

  it("reports with the reason chosen and the note trimmed, which blocks too", async () => {
    const sent = api(done);
    const gone = jest.fn();
    await show(gone);
    await press("Block or report");
    await press("Report and block");
    // The same finality as the block's own confirmation: there is no second step after this one.
    expect(screen.getByText(ALSO_BLOCKS)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What is wrong?" })).toBeTruthy();
    // The group is named by the question, so a screen reader hears it with each reason.
    expect(screen.getByLabelText("What is wrong?").props.accessibilityRole).toBe("radiogroup");
    expect(screen.getAllByRole("radio").map((radio) => radio.props.accessibilityLabel)).toEqual([
      "Harassing, threatening or hateful",
      "A fake profile, or someone else's photos",
      "May be under 18",
      "Selling, advertising or asking for money",
      "Seems automated, or collects people's details",
      "Something else",
    ]);
    // A reason first: the send waits for one.
    expect(disabled("Send report")).toBe(true);
    noProblems();
    await press("May be under 18", "radio");
    // The choice is said in words, never by colour alone.
    expect(
      screen.getByRole("radio", { name: "✓ May be under 18" }).props.accessibilityState,
    ).toEqual(expect.objectContaining({ checked: true }));
    expect(disabled("Send report")).toBe(false);
    await type("  Says in the bio they are in year nine.  ");
    expect(screen.getByLabelText(NOTE_LABEL).props.maxLength).toBe(500);
    await press("Send report");
    expect(
      await screen.findByText(
        "Thank you. A moderator will look at it, and you will not see each other again.",
      ),
    ).toBeTruthy();
    expect(sent).toEqual([
      {
        path: "/reports",
        body: {
          accountId: SUBJECT,
          reason: "under_age",
          note: "Says in the bio they are in year nine.",
        },
      },
    ]);
    // One request: the report is the block as well.
    expect(sent.some((s) => s.path === "/blocks")).toBe(false);
    noProblems();
    await pressDone();
    expect(gone).toHaveBeenCalledWith(SUBJECT);
  });

  it("leaves a blank note out of the report", async () => {
    const sent = api(done);
    await show();
    await press("Block or report");
    await press("Report and block");
    await press("Something else", "radio");
    await press("Harassing, threatening or hateful", "radio");
    expect(screen.queryByRole("radio", { name: "✓ Something else" })).toBeNull();
    await type("   ");
    await press("Send report");
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({ accountId: SUBJECT, reason: "harassment" });
  });

  it("says the day's reports are filed, keeps the words, and offers the block in their place", async () => {
    let answer = () => refusal("report_budget_exceeded", 429);
    const sent = api(() => answer());
    const gone = jest.fn();
    await show(gone);
    await press("Block or report");
    await press("Report and block");
    await press("Selling, advertising or asking for money", "radio");
    await type("Sells supplements.");
    await press("Send report");
    // No promise of a report later: a blocked person's card is gone for good.
    expect(await screen.findByText(CAP)).toBeTruthy();
    expect(screen.getByLabelText(NOTE_LABEL).props.value).toBe("Sells supplements.");
    noProblems();
    answer = done;
    await press("Block");
    // The block is confirmed like any other.
    expect(screen.getByText("Block this person?")).toBeTruthy();
    expect(screen.queryByText(/enough reports for today/)).toBeNull();
    await press("Block");
    await screen.findByText("Blocked. You will not see each other again.");
    expect(sent.map((s) => s.path)).toEqual(["/reports", "/blocks"]);
    await pressDone();
    expect(gone).toHaveBeenCalledWith(SUBJECT);
  });

  it("keeps the reason and the words when a report fails, the per-person limit included", async () => {
    let answer = () => refusal("internal_error", 500);
    api(() => answer());
    await show();
    await press("Block or report");
    await press("Report and block");
    await press("Seems automated, or collects people's details", "radio");
    await type("Sent the same opener to my friend.");
    await press("Send report");
    expect(await screen.findByText("The report could not be sent. Try again.")).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: "✓ Seems automated, or collects people's details" }),
    ).toBeTruthy();
    expect(screen.getByLabelText(NOTE_LABEL).props.value).toBe(
      "Sent the same opener to my friend.",
    );
    // A 429 that is not the day's reports is no cap to explain: a failure like another.
    answer = () => refusal("rate_limited", 429);
    await press("Send report");
    expect(screen.getByText("The report could not be sent. Try again.")).toBeTruthy();
    expect(screen.queryByText(/enough reports for today/)).toBeNull();
    // Cancel forgets it all: the next report starts empty.
    await press("Cancel");
    await press("Block or report");
    await press("Report and block");
    expect(screen.queryByRole("radio", { name: /✓/ })).toBeNull();
    expect(screen.getByLabelText(NOTE_LABEL).props.value).toBe("");
    expect(screen.queryByText("The report could not be sent. Try again.")).toBeNull();
  });

  it.each([
    ["ios", "ios"],
    ["android", "android"],
  ] as const)(
    "says it is sending and holds the buttons, and a report that lands after the dialog closed still takes the card away, said aloud on %s",
    async (_, os) => {
      jest.replaceProperty(Platform, "OS", os);
      let land: (response: Response) => void = () => undefined;
      api(() => new Promise<Response>((resolve) => (land = resolve)));
      const gone = jest.fn();
      await show(gone);
      await press("Block or report");
      await press("Report and block");
      await press("Something else", "radio");
      await press("Send report");
      expect(screen.getByText("Sending…")).toBeTruthy();
      expect(disabled("Send report")).toBe(true);
      expect(disabled("Cancel")).toBe(true);
      expect(screen.getByLabelText(NOTE_LABEL).props.editable).toBe(false);
      await press("Close");
      expect(screen.queryByText("Sending…")).toBeNull();
      expect(gone).not.toHaveBeenCalled();
      await act(async () => {
        land(done());
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      });
      expect(gone).toHaveBeenCalledWith(SUBJECT);
      expect(screen.queryByText(/Thank you/)).toBeNull();
      // Nothing on the screen says it, so it is spoken, whichever the platform.
      expect(announced().at(-1)).toBe(
        "Thank you. A moderator will look at it, and you will not see each other again.",
      );
    },
  );

  it("keeps the reason and the words through a tap outside the dialog or its corner, and Cancel alone forgets them", async () => {
    const sent = api(done);
    const gone = jest.fn();
    await show(gone);
    await press("Block or report");
    await press("Report and block");
    await press("May be under 18", "radio");
    await type("Says she is in year nine.");
    for (const away of [pressScrim, () => press("Close")]) {
      await away();
      expect(screen.queryByRole("radio", { name: "✓ May be under 18" })).toBeNull();
      // Opened again where it was, with what was chosen and typed.
      await press("Block or report");
      expect(screen.getByRole("radio", { name: "✓ May be under 18" })).toBeTruthy();
      expect(screen.getByLabelText(NOTE_LABEL).props.value).toBe("Says she is in year nine.");
    }
    expect(sent).toEqual([]);
    expect(gone).not.toHaveBeenCalled();
    await press("Cancel");
    await press("Block or report");
    expect(screen.getByRole("button", { name: "Report and block" })).toBeTruthy();
  });

  it("opens again where it was, and says so, when a report fails after the dialog was closed", async () => {
    let land: (response: Response) => void = () => undefined;
    api(() => new Promise<Response>((resolve) => (land = resolve)));
    const gone = jest.fn();
    await show(gone);
    await press("Block or report");
    await press("Report and block");
    await press("May be under 18", "radio");
    await type("Says she is in year nine.");
    await press("Send report");
    await press("Close");
    expect(screen.queryByText("Report and block")).toBeNull();
    await act(async () => {
      land(refusal("internal_error", 500));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByText("The report could not be sent. Try again.")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "✓ May be under 18" })).toBeTruthy();
    expect(screen.getByLabelText(NOTE_LABEL).props.value).toBe("Says she is in year nine.");
    expect(disabled("Send report")).toBe(false);
    expect(gone).not.toHaveBeenCalled();
  });

  it.each([
    ["a block", "/blocks"],
    ["a report", "/reports"],
  ])("says a card the API no longer has is gone after %s, and hands it back", async (_, path) => {
    const sent = api(() => refusal("not_found", 404));
    const gone = jest.fn();
    await show(gone);
    await press("Block or report");
    if (path === "/blocks") {
      await press("Block");
      await press("Block");
    } else {
      await press("Report and block");
      await press("Something else", "radio");
      await press("Send report");
    }
    expect(await screen.findByText("This profile is no longer available.")).toBeTruthy();
    // Trying again cannot help, so nothing offers it.
    expect(screen.queryByText(/Try again/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Block" })).toBeNull();
    expect(sent.map((s) => s.path)).toEqual([path]);
    expect(announced()).toContain("This profile is no longer available.");
    await pressDone();
    expect(gone).toHaveBeenCalledWith(SUBJECT);
  });

  it("announces each outcome on iOS, which has no live regions, and moves the focus to each step's title", async () => {
    let answer = () => refusal("internal_error", 500);
    api(() => answer());
    await show();
    await press("Block or report");
    const focused = AccessibilityInfo.sendAccessibilityEvent as jest.Mock;
    expect(focused).toHaveBeenLastCalledWith(expect.anything(), "focus");
    const before = focused.mock.calls.length;
    await press("Block");
    // The pressed button is gone; the focus goes to the confirmation's title.
    expect(focused.mock.calls.length).toBeGreaterThan(before);
    expect(focused.mock.calls.at(-1)?.[1]).toBe("focus");
    await press("Block");
    answer = done;
    await press("Block");
    await screen.findByText("Blocked. You will not see each other again.");
    expect(announced()).toEqual([
      "Sending…",
      "The block did not go through. Try again.",
      "Sending…",
      "Blocked. You will not see each other again.",
    ]);
  });

  it("announces nothing on Android, where the live regions speak the same words", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    api(done);
    await show();
    await press("Block or report");
    await press("Block");
    await press("Block");
    await screen.findByText("Blocked. You will not see each other again.");
    expect(announced()).toEqual([]);
  });

  it("is bounded by the window, scrolls its middle, keeps the app's text-size cap, and lets the keyboard go", async () => {
    api(done);
    await show();
    await press("Block or report");
    await press("Report and block");
    const title = screen.getByText("Report and block");
    expect(title.props.maxFontSizeMultiplier).toBe(2);
    expect(screen.getByText(ALSO_BLOCKS).props.maxFontSizeMultiplier).toBe(2);
    const field = screen.getByLabelText(NOTE_LABEL);
    expect(field.props).toMatchObject({ submitBehavior: "blurAndSubmit", returnKeyType: "done" });
    const scroller = screen.container.queryAll(
      (node) => node.props.keyboardDismissMode === "on-drag",
    )[0];
    expect(scroller?.props).toMatchObject({ automaticallyAdjustKeyboardInsets: true });
  });

  it("speaks the person's language", async () => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: "fi-FI" }]);
    api(done);
    await show();
    await press("Estä tai ilmoita");
    expect(screen.getByRole("button", { name: "Ilmoita ja estä" })).toBeTruthy();
    await press("Estä");
    expect(screen.getByText("Estetäänkö tämä henkilö?")).toBeTruthy();
  });
});
