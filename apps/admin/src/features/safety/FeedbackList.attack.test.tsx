import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource } from "../../lib/api.ts";
import { attack } from "../../test/attack.ts";
import { held, json, network, on, sentTo, settled } from "../../test/network.ts";
import { FeedbackList } from "./FeedbackList.tsx";

// What goes through today (#380): a question, where no line says what should happen.
const QUESTION = "#380, a question";

// Attacks on the feedback list (#380, #171): its rows, each marked handled on
// its own, tried the wrong way beside a control that does it rightly.

const LIST = "/admin/feedback";
const HANDLED = /^\/admin\/feedback\/[^/]+\/handled$/;

const id = (n: number) => `0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${n.toString(16).padStart(2, "0")}`;
const row = (n: number) => ({
  id: id(n),
  accountId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  kind: "bug",
  text: `A few lines, number ${n}.`,
  appVersion: "0.22.0",
  platform: "ios",
  locale: "fi",
  createdAt: "2026-10-15T12:00:00.000Z",
  handledAt: null,
});
const listOf = (...ns: number[]) => json({ items: ns.map(row), total: ns.length });
const marked = (n: number) => json({ id: id(n), handledAt: "2026-10-15T13:00:00.000Z" });
const failure = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const handledOf = (n: number) => `/admin/feedback/${id(n)}/handled`;

/** A row still waiting, by its words. */
const rowOf = (n: number) =>
  screen.getByText(`A few lines, number ${n}.`).closest("li") as HTMLElement;
const markRow = (n: number) =>
  fireEvent.click(within(rowOf(n)).getByRole("button", { name: "Mark as handled" }));

async function settle() {
  for (let turn = 0; turn < 3; turn++) await settled();
}

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter>
        <FeedbackList />
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Mark as handled pressed, and pressed again: while the first is out, or after it came back failed. */
async function markedTwice(firstFailedBefore: boolean) {
  const first = held();
  let posts = 0;
  const sent = network([
    on("GET", LIST, () => listOf(1)),
    on("POST", HANDLED, () => (posts++ === 0 ? first.promise : marked(1))),
  ]);
  show();
  await screen.findByText("1 waiting");
  markRow(1);
  if (firstFailedBefore) {
    first.answer(failure("internal_error", 500));
    await screen.findByRole("alert");
  }
  markRow(1);
  await settle();
  return sentTo(sent, "POST", HANDLED).length;
}

attack("FeedbackList: Mark as handled pressed again while the first is out sends a second one", {
  attempt: () => markedTwice(false),
  control: () => markedTwice(true),
  succeeds: (marks) => expect(marks).toBeGreaterThan(1),
});

/** Both rows marked; one of them fails while the other is still out. */
async function failedBeside(failing: 1 | 2) {
  const fails = held();
  const other = held();
  network([
    on("GET", LIST, () => listOf(1, 2)),
    on("POST", handledOf(failing), () => fails.promise),
    on("POST", handledOf(failing === 1 ? 2 : 1), () => other.promise),
  ]);
  show();
  await screen.findByText("2 waiting");
  markRow(1);
  markRow(2);
  fails.answer(failure("internal_error", 500));
  await settle();
  return within(rowOf(2)).queryByRole("alert") !== null;
}

attack("FeedbackList: one row's failed marking is said on the row marked after it", {
  attempt: () => failedBeside(1),
  control: () => failedBeside(2),
  succeeds: (saidOnSecond) => expect(saidOnSecond).toBe(true),
});

/** Both rows marked, one succeeding and one failing, the second row's answer first. */
async function answeredInReverse(succeeding: 1 | 2) {
  const one = held();
  const two = held();
  network([
    on("GET", LIST, () => listOf(1, 2)),
    on("POST", handledOf(1), () => one.promise),
    on("POST", handledOf(2), () => two.promise),
  ]);
  show();
  await screen.findByText("2 waiting");
  markRow(1);
  markRow(2);
  const answerFor = (n: 1 | 2) => (n === succeeding ? marked(n) : failure("internal_error", 500));
  two.answer(answerFor(2));
  await settle();
  one.answer(answerFor(1));
  await settle();
  // Row 2 shown as handled: its words are gone.
  return screen.queryByText("A few lines, number 2.") === null;
}

attack("FeedbackList: two markings answered in reverse order give one row the other's outcome", {
  attempt: () => answeredInReverse(1),
  control: () => answeredInReverse(2),
  succeeds: (secondShownHandled) => expect(secondShownHandled).toBe(true),
});

async function refusedMarking(code: string, status: number) {
  network([on("GET", LIST, () => listOf(1)), on("POST", HANDLED, () => failure(code, status))]);
  show();
  await screen.findByText("1 waiting");
  markRow(1);
  await settle();
  return screen.queryByRole("button", { name: "Mark as handled" }) !== null;
}

// 409 feedback_handled: another moderator marked it meanwhile, so a second press is refused again.
attack("FeedbackList: a row another moderator marked meanwhile still offers Mark as handled", {
  // Goes through today: a 409 is read as any failure, and the button stays.
  open: QUESTION,
  attempt: () => refusedMarking("feedback_handled", 409),
  control: () => refusedMarking("internal_error", 500),
  succeeds: (offered) => expect(offered).toBe(true),
});

/** Mark as handled pressed from the keyboard; the control then plants the lost focus itself. */
async function markedByKeyboard(blurredAfter: boolean) {
  network([on("GET", LIST, () => listOf(1)), on("POST", HANDLED, () => marked(1))]);
  show();
  const button = await screen.findByRole("button", { name: "Mark as handled" });
  button.focus();
  fireEvent.click(button);
  await screen.findByText("Handled.");
  if (blurredAfter) (document.activeElement as HTMLElement | null)?.blur();
  await settle();
  return document.activeElement === document.body;
}

attack("FeedbackList: the focus falls to the page's body after a row is marked from the keyboard", {
  // Goes through today: the button is replaced by the outcome, and the focus is not moved.
  open: QUESTION,
  attempt: () => markedByKeyboard(false),
  control: () => markedByKeyboard(true),
  succeeds: (onBody) => expect(onBody).toBe(true),
});
