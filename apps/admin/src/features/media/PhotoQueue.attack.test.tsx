import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource, setUnauthorizedHandler } from "../../lib/api.ts";
import { attack } from "../../test/attack.ts";
import { type Held, held, json, network, on, sentTo, settled } from "../../test/network.ts";
import { PhotoQueue } from "./PhotoQueue.tsx";

// What goes through today (#380): a question, where no line says what should happen.
const QUESTION = "#380, a question";

// Attacks on the photo queue (#380, #49): its reads (the queue, a photo's
// signed URL) and its writes (approve, reject with a reason), each tried the
// wrong way beside a control that does the same thing rightly.

const QUEUE = "/admin/photos/queue";
const CARD = /^\/admin\/photos\/[^/]+\/card$/;
const DECISION = /^\/admin\/photos\/[^/]+\/decision$/;

const photo = (n: number) => `0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${n.toString(16).padStart(2, "0")}`;
/** Each owner's id starts differently, so the link under a photo names its item. */
const owner = (n: number) => `${(160 + n).toString(16)}1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b`;
const item = (n: number, extra: Record<string, unknown> = {}) => ({
  photoId: photo(n),
  accountId: owner(n),
  state: "queued",
  blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
  width: 800,
  height: 1067,
  uploadedAt: "2026-09-25T12:00:00.000Z",
  checkedAt: "2026-09-25T12:00:02.000Z",
  // No labels, so the only list items on the screen are the queue's.
  labels: [],
  faces: 1,
  flagged: [],
  appealed: false,
  sensitive: false,
  ...extra,
});
const queueOf = (items: unknown[], total = items.length) => json({ items, total });
const card = () =>
  json({
    url: "https://media.test/media/k/card.webp?Signature=s",
    variant: "card",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
const decided = (n: number, state: "approved" | "rejected") =>
  json({ photoId: photo(n), state, rejectionReason: state === "rejected" ? "nudity" : null });
const failure = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const decisionOf = (n: number) => `/admin/photos/${photo(n)}/decision`;

/** A photo still waiting, found by the link to its owner's page. */
const itemOf = (n: number) =>
  screen
    .getByRole("link", { name: `Account ${owner(n).slice(0, 8)}` })
    .closest("li") as HTMLElement;
const choose = (row: HTMLElement, reason: string) =>
  fireEvent.change(within(row).getByLabelText("Reason the person is told"), {
    target: { value: reason },
  });

/** Lets every answer given so far reach the screen. */
async function settle() {
  for (let turn = 0; turn < 3; turn++) await settled();
}

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter>
        <PhotoQueue />
      </MemoryRouter>
    </I18nProvider>,
  );
}

// How often the session was ended, as the shell's handler would end it.
let ended = 0;
beforeEach(() => {
  ended = 0;
  setTokenSource(() => "t".repeat(43));
  setUnauthorizedHandler(() => {
    ended += 1;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setUnauthorizedHandler(() => undefined);
});

/** Two refreshes out at once; the answer given last carries the older list, from the older request or the newer. */
async function refreshedTwice(order: "reverse" | "in order") {
  const first = held();
  const second = held();
  const later = [first, second];
  let loads = 0;
  const sent = network([
    on("GET", QUEUE, () => (loads++ === 0 ? queueOf([item(1)]) : (later.shift() as Held).promise)),
    on("GET", CARD, card),
  ]);
  show();
  await screen.findByText("1 waiting");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await settle();
  expect(sentTo(sent, "GET", QUEUE)).toHaveLength(3);
  const [early, late] = order === "reverse" ? [second, first] : [first, second];
  early.answer(queueOf([item(2), item(3)]));
  await settle();
  late.answer(queueOf([item(1)]));
  await settle();
  return screen.queryByText(/waiting$/)?.textContent;
}

attack("PhotoQueue: the older of two refreshes, answered last, is the list shown", {
  attempt: () => refreshedTwice("reverse"),
  control: () => refreshedTwice("in order"),
  succeeds: (total) => expect(total).toBe("1 waiting"),
});

async function refreshedAfterAGoodLoad(answer: () => Response) {
  let loads = 0;
  network([
    on("GET", QUEUE, () => (loads++ === 0 ? queueOf([item(1)]) : answer())),
    on("GET", CARD, card),
  ]);
  show();
  await screen.findByText("1 waiting");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await settle();
  return screen.queryByRole("alert") !== null;
}

attack("PhotoQueue: a refresh that fails after a good load says nothing", {
  attempt: () => refreshedAfterAGoodLoad(() => failure("internal_error", 500)),
  control: () => refreshedAfterAGoodLoad(() => queueOf([item(1)])),
  succeeds: (said) => expect(said).toBe(false),
});

async function fullFirstPage(total: number) {
  const twenty = Array.from({ length: 20 }, (_, i) => item(i + 1));
  network([on("GET", QUEUE, () => queueOf(twenty, total)), on("GET", CARD, card)]);
  show();
  await screen.findAllByRole("button", { name: "Approve" });
  await settle();
  return screen.getByText(/waiting$/).textContent;
}

// admin.queue.total: how many wait in all, past the list's first page too.
attack("PhotoQueue: a full first page says how many it holds, not how many wait in all", {
  attempt: () => fullFirstPage(35),
  control: () => fullFirstPage(20),
  succeeds: (said) => expect(said).toBe("20 waiting"),
});

async function refused(where: "the decision" | "the photo's signed URL", status: number) {
  const refusal = () => failure(status === 401 ? "session_revoked" : "admin_forbidden", status);
  network([
    on("GET", QUEUE, () => queueOf([item(1)])),
    on("GET", CARD, where === "the photo's signed URL" ? refusal : card),
    on("POST", DECISION, refusal),
  ]);
  show();
  const approve = await screen.findByRole("button", { name: "Approve" });
  if (where === "the decision") fireEvent.click(approve);
  await settle();
  return ended;
}

// rules/admin.md: a 401 ends the session, wherever it is found out.
for (const where of ["the decision", "the photo's signed URL"] as const) {
  attack(`PhotoQueue: a 401 on ${where} leaves the session going`, {
    attempt: () => refused(where, 401),
    control: () => refused(where, 403),
    succeeds: (endings) => expect(endings).toBe(0),
  });
}

async function approvedSensitive(looked: boolean) {
  const sent = network([
    on("GET", QUEUE, () => queueOf([item(1, { sensitive: true })])),
    on("GET", CARD, card),
    on("POST", DECISION, () => decided(1, "approved")),
  ]);
  show();
  await screen.findByRole("button", { name: "Show photo" });
  if (looked) {
    fireEvent.click(screen.getByRole("button", { name: "Show photo" }));
    fireEvent.load(await screen.findByRole("img", { name: "Photo under review" }));
  }
  const approve = screen.queryByRole("button", { name: "Approve" });
  if (approve) fireEvent.click(approve);
  await settle();
  return { offered: approve !== null, decisions: sentTo(sent, "POST", DECISION).length };
}

attack("PhotoQueue: Approve goes out for a sensitive photo still hidden behind Show photo", {
  // Goes through today: Approve is offered while the picture is hidden; no line says it must wait.
  open: QUESTION,
  attempt: () => approvedSensitive(false),
  control: () => approvedSensitive(true),
  succeeds: (seen) => expect(seen.decisions).toBeGreaterThan(0),
});

/**
 * Approve pressed while the picture is not on the screen, or once it is.
 * Added after the pile was graded: #657 lists these two beside the hidden
 * photo above (its B5), and the pile had not tried them. The signed URL and
 * the image it points at can each fail or wait independently.
 */
async function approvedUnseen(
  picture: "loading" | "failed" | "image loading" | "image failed" | "shown",
) {
  const never = held();
  const sent = network([
    on("GET", QUEUE, () => queueOf([item(1)])),
    on("GET", CARD, () => {
      if (picture === "loading") return never.promise;
      return picture === "failed" ? failure("internal_error", 500) : card();
    }),
    on("POST", DECISION, () => decided(1, "approved")),
  ]);
  show();
  if (picture === "shown" || picture === "image loading" || picture === "image failed") {
    const image = await screen.findByRole("img", { name: "Photo under review" });
    if (picture === "shown") fireEvent.load(image);
    else if (picture === "image failed") fireEvent.error(image);
  }
  const approve = await screen.findByRole("button", { name: "Approve" });
  await settle();
  fireEvent.click(approve);
  await settle();
  return { decisions: sentTo(sent, "POST", DECISION).length };
}

for (const [how, picture] of [
  ["while its picture is still loading", "loading"],
  ["after its picture failed to load", "failed"],
  ["whose signed URL arrived but whose image is still loading", "image loading"],
  ["whose signed URL arrived but whose image failed to load", "image failed"],
] as const) {
  attack(`PhotoQueue: Approve goes out for a photo ${how}`, {
    // Goes through today: Approve waits for nothing but its own request.
    open: QUESTION,
    attempt: () => approvedUnseen(picture),
    control: () => approvedUnseen("shown"),
    succeeds: (seen) => expect(seen.decisions).toBeGreaterThan(0),
  });
}

/** Approve pressed, and pressed again: while the first is out, or after it came back failed. */
async function approvedTwice(firstFailedBefore: boolean) {
  const first = held();
  let posts = 0;
  const sent = network([
    on("GET", QUEUE, () => queueOf([item(1)])),
    on("GET", CARD, card),
    on("POST", DECISION, () => (posts++ === 0 ? first.promise : decided(1, "approved"))),
  ]);
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  if (firstFailedBefore) {
    first.answer(failure("internal_error", 500));
    await screen.findByRole("alert");
  }
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await settle();
  return sentTo(sent, "POST", DECISION).length;
}

attack("PhotoQueue: Approve pressed again while the first decision is out sends a second one", {
  attempt: () => approvedTwice(false),
  control: () => approvedTwice(true),
  succeeds: (decisions) => expect(decisions).toBeGreaterThan(1),
});

/** Show photo pressed twice: on one hidden photo, or once on each of two. */
async function shownTwice(photos: 1 | 2) {
  const never = held();
  const sent = network([
    on("GET", QUEUE, () =>
      queueOf(Array.from({ length: photos }, (_, i) => item(i + 1, { sensitive: true }))),
    ),
    on("GET", CARD, () => never.promise),
  ]);
  show();
  const buttons = await screen.findAllByRole("button", { name: "Show photo" });
  fireEvent.click(buttons[0] as HTMLElement);
  fireEvent.click(buttons[photos - 1] as HTMLElement);
  await settle();
  return sentTo(sent, "GET", CARD).length;
}

// Every signed URL is an audit row of a look (#253): one press, one look.
attack("PhotoQueue: Show photo pressed twice on one photo asks for two signed URLs", {
  attempt: () => shownTwice(1),
  control: () => shownTwice(2),
  succeeds: (urls) => expect(urls).toBeGreaterThan(1),
});

/** One photo's approval fails while the other's rejection form is open with a reason chosen. */
async function failedBeside(failing: 1 | 2) {
  const answer = held();
  const other = failing === 1 ? 2 : 1;
  network([
    on("GET", QUEUE, () => queueOf([item(1), item(2)])),
    on("GET", CARD, card),
    on("POST", decisionOf(failing), () => answer.promise),
  ]);
  show();
  await screen.findAllByRole("button", { name: "Approve" });
  fireEvent.click(within(itemOf(failing)).getByRole("button", { name: "Approve" }));
  fireEvent.click(within(itemOf(other)).getByRole("button", { name: "Reject…" }));
  choose(itemOf(other), "nudity");
  answer.answer(failure("internal_error", 500));
  await settle();
  return within(itemOf(2)).queryByRole("alert") !== null;
}

attack(
  "PhotoQueue: one photo's failed decision is said on another photo, whose rejection form is open",
  {
    attempt: () => failedBeside(1),
    control: () => failedBeside(2),
    succeeds: (saidOnSecond) => expect(saidOnSecond).toBe(true),
  },
);

/** Two decisions out at once, the second photo's answered first. */
async function decidedInReverse(firstPhoto: "reject" | "approve") {
  const one = held();
  const two = held();
  network([
    on("GET", QUEUE, () => queueOf([item(1), item(2)])),
    on("GET", CARD, card),
    on("POST", decisionOf(1), () => one.promise),
    on("POST", decisionOf(2), () => two.promise),
  ]);
  show();
  await screen.findAllByRole("button", { name: "Approve" });
  const outcome = { 1: firstPhoto, 2: firstPhoto === "reject" ? "approve" : "reject" } as const;
  for (const n of [1, 2] as const) {
    const row = itemOf(n);
    if (outcome[n] === "approve") {
      fireEvent.click(within(row).getByRole("button", { name: "Approve" }));
    } else {
      fireEvent.click(within(row).getByRole("button", { name: "Reject…" }));
      choose(row, "nudity");
      fireEvent.click(within(row).getByRole("button", { name: "Reject photo" }));
    }
  }
  const answered = (n: 1 | 2) => decided(n, outcome[n] === "approve" ? "approved" : "rejected");
  two.answer(answered(2));
  await settle();
  one.answer(answered(1));
  await settle();
  return screen.getAllByRole("listitem").map((li) => li.textContent);
}

attack("PhotoQueue: two decisions answered in reverse order show each other's outcome", {
  attempt: () => decidedInReverse("reject"),
  control: () => decidedInReverse("approve"),
  succeeds: (lines) => expect(lines).toEqual(["Approved", "Rejected"]),
});

const presets = {
  // The reason chosen on photo 1, or on photo 2 itself.
  "the one chosen on another photo": async (attempt: boolean) => {
    fireEvent.click(within(itemOf(1)).getByRole("button", { name: "Reject…" }));
    if (attempt) choose(itemOf(1), "nudity");
    fireEvent.click(within(itemOf(2)).getByRole("button", { name: "Reject…" }));
    if (!attempt) choose(itemOf(2), "nudity");
    return itemOf(2);
  },
  // The reason chosen before Cancel, or after the form opened again.
  "the one chosen before Cancel": async (attempt: boolean) => {
    fireEvent.click(within(itemOf(1)).getByRole("button", { name: "Reject…" }));
    if (attempt) choose(itemOf(1), "nudity");
    fireEvent.click(within(itemOf(1)).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(itemOf(1)).getByRole("button", { name: "Reject…" }));
    if (!attempt) choose(itemOf(1), "nudity");
    return itemOf(1);
  },
};

// No reason is preset (#250): a rejection's reason is chosen on purpose.
for (const [which, steps] of Object.entries(presets)) {
  const reasonShown = async (attempt: boolean) => {
    network([on("GET", QUEUE, () => queueOf([item(1), item(2)])), on("GET", CARD, card)]);
    show();
    await screen.findAllByRole("button", { name: "Approve" });
    const row = await steps(attempt);
    await settle();
    return (within(row).getByLabelText("Reason the person is told") as HTMLSelectElement).value;
  };
  attack(`PhotoQueue: a rejection form opens with a reason already chosen, ${which}`, {
    attempt: () => reasonShown(true),
    control: () => reasonShown(false),
    succeeds: (reason) => expect(reason).toBe("nudity"),
  });
}

/** Approve pressed from the keyboard; the control then plants the lost focus itself. */
async function approvedByKeyboard(blurredAfter: boolean) {
  network([
    on("GET", QUEUE, () => queueOf([item(1)])),
    on("GET", CARD, card),
    on("POST", DECISION, () => decided(1, "approved")),
  ]);
  show();
  const approve = await screen.findByRole("button", { name: "Approve" });
  approve.focus();
  fireEvent.click(approve);
  await screen.findByText("Approved");
  if (blurredAfter) (document.activeElement as HTMLElement | null)?.blur();
  await settle();
  return document.activeElement === document.body;
}

attack(
  "PhotoQueue: the focus falls to the page's body after a photo is approved from the keyboard",
  {
    // Goes through today: the button is replaced by the outcome, and the focus is not moved.
    open: QUESTION,
    attempt: () => approvedByKeyboard(false),
    control: () => approvedByKeyboard(true),
    succeeds: (onBody) => expect(onBody).toBe(true),
  },
);
