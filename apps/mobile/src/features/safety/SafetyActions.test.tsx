import type { PhotoId } from "@kuutti/schema";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { Image, type ImageRef } from "expo-image";
import { useLocales } from "expo-localization";
import { useState } from "react";
import { AccessibilityInfo, DeviceEventEmitter, Platform, StyleSheet } from "react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import {
  ConversationActions,
  ConversationPhotoReport,
  type ReportPhoto,
  SafetyActions,
  type SafetyOutcome,
} from "./SafetyActions";

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
function Host({
  onGone,
  photos,
}: {
  onGone: (accountId: string) => void;
  photos: readonly ReportPhoto[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <SafetyActions
      accountId={SUBJECT}
      photos={photos}
      open={open}
      onOpenChange={setOpen}
      onGone={onGone}
    />
  );
}
const show = async (
  onGone: (accountId: string) => void = jest.fn(),
  photos: readonly ReportPhoto[] = [],
) => {
  await renderWithTheme(<Host onGone={onGone} photos={photos} />);
};

// A card's own photos (#476), as ProfileCardView names them: the main one in
// the card variant, the rest as thumbs, each heard with its caption and what
// the check saw, and seen with its caption.
const BLURHASH = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
const MAIN = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01" as PhotoId;
const SECOND = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a02" as PhotoId;
const SECOND_HEARD = "Photo 2 of 2. A summer day. Automatic description: One person, outdoors.";
const PHOTOS: readonly ReportPhoto[] = [
  { id: MAIN, variant: "card", blurhash: BLURHASH, label: "Photo 1 of 2", text: "Photo 1 of 2" },
  {
    id: SECOND,
    variant: "thumb",
    blurhash: BLURHASH,
    label: SECOND_HEARD,
    text: "Photo 2 of 2. A summer day",
  },
];
const QUESTION = "Is it about one photo?";
/** The options of Is it about one photo?, as a screen reader hears them, in order. */
const photoChoices = () =>
  within(screen.getByLabelText(QUESTION))
    .getAllByRole("radio")
    .map((radio) => radio.props.accessibilityLabel);
const checked = (name: string) =>
  screen.getByRole("radio", { name }).props.accessibilityState?.checked === true;
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

type Node = ReturnType<typeof screen.container.queryAll>[number];
/** The host views around a node, outward. */
const hostsAround = (node: Node): Node[] => {
  const hosts: Node[] = [];
  for (let up = node.parent; up; up = up.parent) if (typeof up.type === "string") hosts.push(up);
  return hosts;
};
const flat = (node: Node) => StyleSheet.flatten(node.props.style) ?? {};
/**
 * On Android (#351), the report's note with the keyboard up: the space the
 * dialog is given ends at the keyboard's top (here 500, the space from y 8 to
 * 836 of an 844 point window), the dialog shrinks into it, and the scroll view
 * holding the note's label and its field shrinks in the dialog, so the field
 * comes into view just above the keyboard with its label above it, and Send
 * report, outside the scroll view, stays above the keyboard too.
 */
async function expectNoteAboveKeyboard() {
  const [dialog] = screen.container.queryAll(
    (node) => typeof node.type === "string" && node.props.role === "dialog",
  );
  const space = dialog && hostsAround(dialog)[1];
  if (!dialog || !space) throw new Error("no dialog");
  await act(async () => {
    fireEvent(space, "layout", {
      persist: () => undefined,
      nativeEvent: { layout: { x: 8, y: 8, width: 374, height: 828 } },
    });
  });
  await act(async () => {
    fireEvent(screen.getByLabelText(NOTE_LABEL), "focus");
    DeviceEventEmitter.emit("keyboardDidShow", {
      endCoordinates: { screenX: 0, screenY: 500, width: 390, height: 344 },
    });
  });
  expect(flat(space).paddingBottom).toBe(336);
  expect(dialog.props.className).toMatch(/\bshrink\b/);
  const scrollOf = (node: Node) => hostsAround(node).find((up) => up.type === "RCTScrollView");
  const scroll = scrollOf(screen.getByLabelText(NOTE_LABEL));
  if (!scroll) throw new Error("the note is in no scroll view");
  expect(scrollOf(screen.getByText(NOTE_LABEL))).toBe(scroll);
  expect(flat(scroll).flexShrink).toBe(1);
  expect(hostsAround(dialog)).not.toContain(scroll);
  expect(scrollOf(screen.getByText("Send report"))).toBeUndefined();
}

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

  it("asks whether it is about one photo, Not one photo chosen first, each of the card's photos named as the card names it, and sends the one chosen (#476)", async () => {
    const sent = api(done);
    const cache = jest.spyOn(Image, "readFromCacheAsync");
    await show(jest.fn(), PHOTOS);
    await press("Block or report");
    await press("Report and block");
    // After the reasons, a question of its own, heard with each of its options.
    expect(screen.getByRole("heading", { name: QUESTION })).toBeTruthy();
    expect(screen.getByLabelText(QUESTION).props.accessibilityRole).toBe("radiogroup");
    expect(photoChoices()).toEqual(["✓ Not one photo", "Photo 1 of 2", SECOND_HEARD]);
    expect(checked("✓ Not one photo")).toBe(true);
    // Seen beside each picture: its place and its caption, the check's words left to the label.
    expect(screen.getByText("Photo 2 of 2. A summer day")).toBeTruthy();
    // The pictures are the ones the card painted, from the phone's cache: nothing is asked of the API.
    expect(cache.mock.calls).toEqual([[`${MAIN}/card`], [`${SECOND}/thumb`]]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    noProblems();
    await press(SECOND_HEARD, "radio");
    expect(photoChoices()).toEqual(["Not one photo", "Photo 1 of 2", `✓ ${SECOND_HEARD}`]);
    expect(checked(`✓ ${SECOND_HEARD}`)).toBe(true);
    expect(screen.getByText("✓ Photo 2 of 2. A summer day")).toBeTruthy();
    // The photo is an addition: a reason is still needed.
    expect(disabled("Send report")).toBe(true);
    await press("Something else", "radio");
    await press("Send report");
    await screen.findByText(
      "Thank you. A moderator will look at it, and you will not see each other again.",
    );
    expect(sent).toEqual([
      { path: "/reports", body: { accountId: SUBJECT, reason: "other", photoId: SECOND } },
    ]);
  });

  it("leaves the photo out of the report when Not one photo is chosen again (#476)", async () => {
    const sent = api(done);
    await show(jest.fn(), PHOTOS);
    await press("Block or report");
    await press("Report and block");
    await press("Photo 1 of 2", "radio");
    expect(checked("✓ Photo 1 of 2")).toBe(true);
    await press("Not one photo", "radio");
    expect(checked("✓ Not one photo")).toBe(true);
    await press("Harassing, threatening or hateful", "radio");
    await press("Send report");
    await waitFor(() => expect(sent).toHaveLength(1));
    // No key at all: the contract is strict and takes no null.
    expect(sent[0]?.body).toStrictEqual({ accountId: SUBJECT, reason: "harassment" });
  });

  it("keeps the photo chosen through a failure and a tap outside the dialog, and holds its choice while a report is on its way (#476)", async () => {
    let answer: () => Response | Promise<Response> = () => refusal("internal_error", 500);
    const sent = api(() => answer());
    await show(jest.fn(), PHOTOS);
    await press("Block or report");
    await press("Report and block");
    await press(SECOND_HEARD, "radio");
    await press("Something else", "radio");
    await press("Send report");
    expect(await screen.findByText("The report could not be sent. Try again.")).toBeTruthy();
    expect(checked(`✓ ${SECOND_HEARD}`)).toBe(true);
    // Every option waits while a report is on its way, the photos' too.
    answer = () => new Promise<Response>(() => undefined);
    await press("Send report");
    expect(
      within(screen.getByLabelText(QUESTION))
        .getAllByRole("radio")
        .every((radio) => radio.props.accessibilityState?.disabled === true),
    ).toBe(true);
    await pressScrim();
    await press("Block or report");
    expect(checked(`✓ ${SECOND_HEARD}`)).toBe(true);
    expect(sent.map((s) => s.body)).toEqual([
      { accountId: SUBJECT, reason: "other", photoId: SECOND },
      { accountId: SUBJECT, reason: "other", photoId: SECOND },
    ]);
  });

  it("forgets the photo chosen on Cancel, so the next report starts at Not one photo (#476)", async () => {
    api(done);
    await show(jest.fn(), PHOTOS);
    await press("Block or report");
    await press("Report and block");
    await press("Photo 1 of 2", "radio");
    await press("Cancel");
    await press("Block or report");
    await press("Report and block");
    expect(photoChoices()).toEqual(["✓ Not one photo", "Photo 1 of 2", SECOND_HEARD]);
  });

  it("asks about no photo on a card without photos (#476)", async () => {
    const cache = jest.spyOn(Image, "readFromCacheAsync");
    api(done);
    await show();
    await press("Block or report");
    await press("Report and block");
    expect(screen.getByRole("heading", { name: "What is wrong?" })).toBeTruthy();
    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(screen.queryByRole("radio", { name: /Not one photo/ })).toBeNull();
    expect(cache).not.toHaveBeenCalled();
  });

  it("shows a photo from the phone's cache where it has it, and its blurhash where it has none (#476)", async () => {
    const painted = { painted: true } as unknown as ImageRef;
    jest
      .spyOn(Image, "readFromCacheAsync")
      .mockImplementation(async (key) => (key === `${MAIN}/card` ? painted : null));
    api(done);
    await show(jest.fn(), PHOTOS);
    await press("Block or report");
    await press("Report and block");
    const picture = (id: string) =>
      screen.getByTestId(`cached-${id}`, { includeHiddenElements: true }).props as {
        source: unknown[];
        placeholder: unknown;
      };
    expect(picture(MAIN).source).toEqual([painted]);
    // A thumb the day's budget refused never reached the cache: the blurhash stands in.
    expect(picture(SECOND).source).toEqual([]);
    expect(JSON.stringify(picture(SECOND).placeholder)).toContain(BLURHASH);
    expect(globalThis.fetch).not.toHaveBeenCalled();
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

  it("keeps the note and its label in sight above the keyboard on Android, Send report too", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    // The dialog module picked iOS's FullWindowOverlay when it loaded; off iOS it warns, beside the point here.
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    api(done);
    await show();
    await press("Block or report");
    await press("Report and block");
    await expectNoteAboveKeyboard();
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

// The conversation's door (#351, ADR-030 §12): "More" in the header, the
// same dialog with Report and block, Block and End conversation, each behind
// its confirmation in words, the copy said with the report, and the outcome
// handed to the screen at once; in an ended conversation the report alone,
// while the window holds, saying that it blocks and not that it ends.

const CONVERSATION = "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a70";
const COPY =
  "The moderators get a copy of this whole conversation, your own messages and photos included, and keep it for twelve months.";
const ALSO_ENDS =
  "A report also blocks them, for good, and ends this conversation for both of you: you will not see each other here again, even if either of you deletes their account. A block cannot be undone. They are not told.";
const REPORT = `/conversations/${CONVERSATION}/report`;
const BLOCK = `/conversations/${CONVERSATION}/block`;
const POINTS = "The report points the moderators to this photo.";

/** The conversation's API: every block and report on it recorded, answered as told. */
function conversationApi(answer: (path: string) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path.startsWith(`/conversations/${CONVERSATION}/`)) {
      const text = await request.text();
      sent.push({ path, body: text ? JSON.parse(text) : null });
      return answer(path);
    }
    return refusal("not_found", 404);
  }) as unknown as typeof fetch;
  return sent;
}

function ConversationHost({
  ended = false,
  reportable = true,
  button = true,
  startOpen = false,
  unmatch = jest.fn(async () => undefined),
  onDone,
  onStale = jest.fn(),
}: {
  ended?: boolean;
  reportable?: boolean;
  button?: boolean;
  startOpen?: boolean;
  unmatch?: () => Promise<void>;
  onDone: (outcome: SafetyOutcome) => void;
  onStale?: () => void;
}) {
  const [open, setOpen] = useState(startOpen);
  return (
    <ConversationActions
      conversationId={CONVERSATION}
      ended={ended}
      reportable={reportable}
      button={button}
      unmatch={unmatch}
      open={open}
      onOpenChange={setOpen}
      onDone={onDone}
      onStale={onStale}
    />
  );
}

describe("ConversationActions", () => {
  it("opens from More with Block, Report and block and End conversation, each said in words", async () => {
    const sent = conversationApi(done);
    const onDone = jest.fn();
    await renderWithTheme(<ConversationHost onDone={onDone} />);
    noProblems();
    await press("More");
    expect(screen.getByText("Report, block or end")).toBeTruthy();
    // In this order, as a screen reader reaches them, each with its line.
    const buttons = screen.getAllByRole("button");
    const at = (name: string) => buttons.indexOf(screen.getByRole("button", { name }));
    const places = ["Block", "Report and block", "End conversation", "Cancel"].map(at);
    expect(places.every((place) => place >= 0)).toBe(true);
    expect([...places].sort((a, b) => a - b)).toEqual(places);
    expect(
      screen.getByText("Neither of you can write in it any more. Nobody is blocked."),
    ).toBeTruthy();
    noProblems();
    await press("Cancel");
    expect(screen.queryByText("Report, block or end")).toBeNull();
    expect(sent).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("reports with the copy and the end said and the reason and note sent, and hands the outcome on at once", async () => {
    const sent = conversationApi(done);
    const onDone = jest.fn();
    await renderWithTheme(<ConversationHost onDone={onDone} />);
    await press("More");
    await press("Report and block");
    expect(screen.getByText(COPY)).toBeTruthy();
    expect(screen.getByText(ALSO_ENDS)).toBeTruthy();
    expect(screen.queryByText(ALSO_BLOCKS)).toBeNull();
    // Points at nothing: a photo is pointed at from its own screen (#476).
    expect(screen.queryByText(POINTS)).toBeNull();
    expect(screen.queryByText("Is it about one photo?")).toBeNull();
    await press("Harassing, threatening or hateful", "radio");
    await type("  Uhkaili.  ");
    noProblems();
    await press("Send report");
    expect(sent).toEqual([
      {
        path: `/conversations/${CONVERSATION}/report`,
        body: { reason: "harassment", note: "Uhkaili." },
      },
    ]);
    expect(onDone).toHaveBeenCalledWith("reported");
    // No Done step: the screen says it.
    expect(screen.queryByText("Report, block or end")).toBeNull();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  });

  it("blocks after words that say the conversation ends for both, and hands the outcome on", async () => {
    const sent = conversationApi(done);
    const onDone = jest.fn();
    await renderWithTheme(<ConversationHost onDone={onDone} />);
    await press("More");
    await press("Block");
    expect(screen.getByText("Block this person?")).toBeTruthy();
    expect(
      screen.getByText(
        "The conversation ends for both of you, and you will not see each other here again, even if either of you deletes their account and comes back. A block cannot be undone. They are not told.",
      ),
    ).toBeTruthy();
    expect(sent).toEqual([]);
    await press("Block");
    expect(sent).toEqual([{ path: `/conversations/${CONVERSATION}/block`, body: null }]);
    expect(onDone).toHaveBeenCalledWith("blocked");
  });

  it("ends the conversation after its confirmation, and keeps the dialog open with words when it fails", async () => {
    conversationApi(done);
    const onDone = jest.fn();
    const unmatch = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    await renderWithTheme(<ConversationHost unmatch={unmatch} onDone={onDone} />);
    await press("More");
    await press("End conversation");
    expect(screen.getByText("End this conversation?")).toBeTruthy();
    expect(
      screen.getByText(
        "Neither of you can write in it any more. It stays in the archive for both of you, and nobody is told who ended it. Nobody is blocked, and either of you can still report it for a while.",
      ),
    ).toBeTruthy();
    expect(unmatch).not.toHaveBeenCalled();
    await press("End conversation");
    expect(screen.getByText("The conversation could not be ended. Try again.")).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    await press("End conversation");
    expect(unmatch).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledWith("unmatched");
  });

  it("hands a conversation gone meanwhile on as gone, and says a report past the window in words, having the screen read it again", async () => {
    const onDone = jest.fn();
    const onStale = jest.fn();
    conversationApi((path) =>
      path.endsWith("/block") ? refusal("not_found", 404) : refusal("report_window_closed", 409),
    );
    await renderWithTheme(<ConversationHost onDone={onDone} onStale={onStale} />);
    await press("More");
    await press("Report and block");
    await press("Something else", "radio");
    await press("Send report");
    expect(screen.getByText("This conversation can no longer be reported.")).toBeTruthy();
    // Trying again cannot help: Send waits for nothing, and what the screen
    // holds, that it can be reported, is read again.
    expect(disabled("Send report")).toBe(true);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    await press("Cancel");
    await press("More");
    await press("Block");
    await press("Block");
    expect(onDone).toHaveBeenCalledWith("gone");
  });

  it("offers only the report in an ended conversation while the window holds, which says it blocks and not that it ends", async () => {
    conversationApi(done);
    const onDone = jest.fn();
    await renderWithTheme(<ConversationHost ended reportable onDone={onDone} />);
    await press("More");
    expect(screen.getByRole("button", { name: "Report and block" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Block" })).toBeNull();
    expect(screen.queryByRole("button", { name: "End conversation" })).toBeNull();
    await press("Report and block");
    expect(screen.getByText(COPY)).toBeTruthy();
    expect(screen.getByText(ALSO_BLOCKS)).toBeTruthy();
    expect(screen.queryByText(ALSO_ENDS)).toBeNull();
    expect(screen.queryByText(/ends/)).toBeNull();
  });

  it("says the day's cap without a Block in an ended conversation, and when it lifts, keeping the words and saying it aloud on iOS", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    conversationApi(() => refusal("report_budget_exceeded", 429));
    await renderWithTheme(<ConversationHost ended reportable onDone={jest.fn()} />);
    await press("More");
    await press("Report and block");
    await press("Something else", "radio");
    await type("Kept writing after I said no.");
    await press("Send report");
    // No promise about this conversation, whose window may close first.
    const limited = "That is enough reports for today. You can send more after midnight.";
    expect(screen.getByText(limited)).toBeTruthy();
    expect(screen.queryByText(CAP)).toBeNull();
    expect(screen.queryByRole("button", { name: "Block" })).toBeNull();
    expect(announced().at(-1)).toBe(limited);
    // Nothing typed is lost to it.
    expect(screen.getByLabelText(NOTE_LABEL).props.value).toBe("Kept writing after I said no.");
    expect(screen.getByRole("radio", { name: "✓ Something else" })).toBeTruthy();
  });

  it("says the day's cap with a Block under it in a conversation going on, which blocks through the conversation's route", async () => {
    const sent = conversationApi((path) =>
      path === REPORT ? refusal("report_budget_exceeded", 429) : done(),
    );
    const onDone = jest.fn();
    await renderWithTheme(<ConversationHost onDone={onDone} />);
    await press("More");
    await press("Report and block");
    await press("Something else", "radio");
    await press("Send report");
    expect(screen.getByText(CAP)).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    await press("Block");
    expect(screen.getByText("Block this person?")).toBeTruthy();
    await press("Block");
    expect(sent.map((s) => s.path)).toEqual([REPORT, BLOCK]);
    expect(onDone).toHaveBeenCalledWith("blocked");
  });

  it("keeps the note and its label in sight above the keyboard on Android, Send report too", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    // The dialog module picked iOS's FullWindowOverlay when it loaded; off iOS it warns, beside the point here.
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    conversationApi(done);
    await renderWithTheme(<ConversationHost onDone={jest.fn()} />);
    await press("More");
    await press("Report and block");
    await expectNoteAboveKeyboard();
  });

  it("keeps an open dialog, its step and its words, when its offers go, and has no More once it closes", async () => {
    conversationApi(() => refusal("report_window_closed", 409));
    const onDone = jest.fn();
    const ui = (reportable: boolean) => (
      <ConversationHost ended reportable={reportable} startOpen onDone={onDone} />
    );
    await renderWithTheme(ui(true));
    await press("Report and block");
    await press("Something else", "radio");
    await type("Threatened me.");
    await press("Send report");
    // The screen read it again: nothing is left to offer.
    await screen.rerender(underProviders(ui(false)));
    expect(screen.getByText("This conversation can no longer be reported.")).toBeTruthy();
    expect(screen.getByLabelText(NOTE_LABEL).props.value).toBe("Threatened me.");
    expect(disabled("Send report")).toBe(true);
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    await press("Cancel");
    expect(screen.queryByText("Report and block")).toBeNull();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("keeps the dialog without More while the screen says the conversation is gone, and hands on what then lands", async () => {
    let land: (response: Response) => void = () => undefined;
    conversationApi(() => new Promise<Response>((resolve) => (land = resolve)));
    const onDone = jest.fn();
    const ui = (button: boolean) => <ConversationHost button={button} onDone={onDone} />;
    await renderWithTheme(ui(true));
    await press("More");
    await press("Block");
    await press("Block");
    expect(screen.getByText("Sending…")).toBeTruthy();
    await screen.rerender(underProviders(ui(false)));
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    expect(screen.getByText("Sending…")).toBeTruthy();
    await act(async () => {
      land(done());
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
    expect(onDone).toHaveBeenCalledWith("blocked");
    expect(screen.queryByText("Block this person?")).toBeNull();
  });

  it("has no More at all when nothing is left to offer", async () => {
    await renderWithTheme(<ConversationHost ended reportable={false} onDone={jest.fn()} />);
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });

  it("speaks the person's language", async () => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: "fi-FI" }]);
    conversationApi(done);
    await renderWithTheme(<ConversationHost onDone={jest.fn()} />);
    await press("Lisää");
    expect(screen.getByText("Ilmoita, estä tai lopeta")).toBeTruthy();
    await press("Lopeta keskustelu");
    expect(screen.getByText("Lopetetaanko tämä keskustelu?")).toBeTruthy();
  });
});

// A conversation photo's door (#476, ADR-030 §13): Report this photo under a
// photo the other person sent opens the conversation's report step at once,
// saying first that the report points the moderators to the photo, then the
// copy and the block as from More, and the report names the photo's place.

const LIMITED = "That is enough reports for today. You can send more after midnight.";
const LATE = "This conversation can no longer be reported.";

function PhotoHost({
  ended = false,
  reportable = true,
  onDone,
  onStale = jest.fn(),
}: {
  ended?: boolean;
  reportable?: boolean;
  onDone: (outcome: SafetyOutcome) => void;
  onStale?: () => void;
}) {
  return (
    <ConversationPhotoReport
      conversationId={CONVERSATION}
      seq={4}
      ended={ended}
      reportable={reportable}
      onDone={onDone}
      onStale={onStale}
    />
  );
}
/** The report step's lines, in the order they are read. */
const reportLines = () =>
  screen
    .getAllByText(/./)
    .map((node) => node.props.children)
    .filter((line) => [POINTS, COPY, ALSO_ENDS, ALSO_BLOCKS].includes(line));

describe("ConversationPhotoReport", () => {
  it("opens the report step from Report this photo, its title taking the focus, saying the photo first, then the copy and that it ends the conversation, and sends the reason, the note and the photo's place", async () => {
    const sent = conversationApi(done);
    const onDone = jest.fn();
    await renderWithTheme(<PhotoHost onDone={onDone} />);
    // One labelled button, at least 44 points.
    expect(pressables(screen.toJSON() as HostNode)).toHaveLength(1);
    noProblems();
    const focused = AccessibilityInfo.sendAccessibilityEvent as jest.Mock;
    await press("Report this photo");
    expect(screen.getByText("Report and block")).toBeTruthy();
    expect(focused).toHaveBeenLastCalledWith(expect.anything(), "focus");
    expect(reportLines()).toEqual([POINTS, COPY, ALSO_ENDS]);
    // Straight to the report: no choice before it, and no photo to choose.
    expect(screen.queryByRole("button", { name: "End conversation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Block" })).toBeNull();
    expect(screen.queryByText("Is it about one photo?")).toBeNull();
    noProblems();
    await press("Harassing, threatening or hateful", "radio");
    await type("  Lähetti tämän pyytämättä.  ");
    await press("Send report");
    expect(sent).toEqual([
      { path: REPORT, body: { reason: "harassment", note: "Lähetti tämän pyytämättä.", seq: 4 } },
    ]);
    expect(onDone).toHaveBeenCalledWith("reported");
    expect(screen.queryByText("Report and block")).toBeNull();
  });

  it("says in an ended conversation that the report blocks, not that it ends, and the day's cap without a Block", async () => {
    const sent = conversationApi(() => refusal("report_budget_exceeded", 429));
    await renderWithTheme(<PhotoHost ended onDone={jest.fn()} />);
    await press("Report this photo");
    expect(reportLines()).toEqual([POINTS, COPY, ALSO_BLOCKS]);
    await press("Something else", "radio");
    await press("Send report");
    expect(screen.getByText(LIMITED)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Block" })).toBeNull();
    expect(sent).toEqual([{ path: REPORT, body: { reason: "other", seq: 4 } }]);
  });

  it("offers a Block under the day's cap while the conversation goes on, through the conversation's route", async () => {
    const sent = conversationApi((path) =>
      path === REPORT ? refusal("report_budget_exceeded", 429) : done(),
    );
    const onDone = jest.fn();
    await renderWithTheme(<PhotoHost onDone={onDone} />);
    await press("Report this photo");
    await press("Something else", "radio");
    await press("Send report");
    expect(screen.getByText(CAP)).toBeTruthy();
    await press("Block");
    expect(screen.getByText("Block this person?")).toBeTruthy();
    await press("Block");
    expect(sent.map((s) => s.path)).toEqual([REPORT, BLOCK]);
    expect(onDone).toHaveBeenCalledWith("blocked");
  });

  it("opens at the report step again after Cancel, from the block's confirmation too, with nothing chosen or typed", async () => {
    conversationApi((path) => (path === REPORT ? refusal("report_budget_exceeded", 429) : done()));
    await renderWithTheme(<PhotoHost onDone={jest.fn()} />);
    await press("Report this photo");
    await press("Something else", "radio");
    await type("Kept sending these.");
    await press("Cancel");
    expect(screen.queryByText("Report and block")).toBeNull();
    await press("Report this photo");
    expect(screen.getByText("Report and block")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /✓/ })).toBeNull();
    expect(screen.getByLabelText(NOTE_LABEL).props.value).toBe("");
    await press("Something else", "radio");
    await press("Send report");
    await press("Block");
    await press("Cancel");
    await press("Report this photo");
    expect(screen.getByText("Report and block")).toBeTruthy();
    expect(screen.queryByText("Block this person?")).toBeNull();
  });

  it("says a report past the window, has the screen read again, keeps the open dialog when the button goes, and has no button once it closes", async () => {
    conversationApi(() => refusal("report_window_closed", 409));
    const onStale = jest.fn();
    const ui = (reportable: boolean) => (
      <PhotoHost ended reportable={reportable} onDone={jest.fn()} onStale={onStale} />
    );
    await renderWithTheme(ui(true));
    await press("Report this photo");
    await press("Something else", "radio");
    await type("Threatened me.");
    await press("Send report");
    expect(screen.getByText(LATE)).toBeTruthy();
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(disabled("Send report")).toBe(true);
    await screen.rerender(underProviders(ui(false)));
    expect(screen.getByText(LATE)).toBeTruthy();
    expect(screen.getByLabelText(NOTE_LABEL).props.value).toBe("Threatened me.");
    expect(screen.queryByRole("button", { name: "Report this photo" })).toBeNull();
    await press("Cancel");
    expect(screen.queryByText("Report and block")).toBeNull();
    expect(pressables(screen.toJSON() as HostNode)).toEqual([]);
  });

  it("says a failed report in the dialog, opened again, when the button went and the dialog was closed while it was sending", async () => {
    let release: (response: Response) => void = () => undefined;
    conversationApi(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const ui = (reportable: boolean) => <PhotoHost reportable={reportable} onDone={jest.fn()} />;
    await renderWithTheme(ui(true));
    await press("Report this photo");
    await press("Something else", "radio");
    await press("Send report");
    // The screen's read again fails meanwhile, so the button goes; the person closes the dialog.
    await screen.rerender(underProviders(ui(false)));
    await pressScrim();
    expect(screen.queryByText("Report and block")).toBeNull();
    await act(async () => {
      release(refusal("internal_error", 500));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
    expect(await screen.findByText("The report could not be sent. Try again.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Report this photo" })).toBeNull();
  });

  it("hands a conversation gone meanwhile on as gone", async () => {
    conversationApi(() => refusal("not_found", 404));
    const onDone = jest.fn();
    await renderWithTheme(<PhotoHost onDone={onDone} />);
    await press("Report this photo");
    await press("Something else", "radio");
    await press("Send report");
    expect(onDone).toHaveBeenCalledWith("gone");
    expect(screen.queryByText("Report and block")).toBeNull();
  });

  it("has no button while the conversation takes no report", async () => {
    await renderWithTheme(<PhotoHost reportable={false} onDone={jest.fn()} />);
    expect(screen.queryByRole("button", { name: "Report this photo" })).toBeNull();
    expect(pressables(screen.toJSON() as HostNode)).toEqual([]);
  });

  it("speaks the person's language", async () => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: "fi-FI" }]);
    conversationApi(done);
    await renderWithTheme(<PhotoHost onDone={jest.fn()} />);
    await press("Ilmoita tästä kuvasta");
    expect(screen.getByText("Ilmoita ja estä")).toBeTruthy();
    expect(screen.getByText("Ilmoitus ohjaa moderaattorit tähän kuvaan.")).toBeTruthy();
  });
});
