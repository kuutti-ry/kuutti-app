import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource } from "../../lib/api.ts";
import { attack } from "../../test/attack.ts";
import { type Held, held, json, network, on, sentTo, settled } from "../../test/network.ts";
import { ConfigList } from "./ConfigList.tsx";

// What goes through today (#380): a question, where no line says what should happen.
const QUESTION = "#380, a question";

// Attacks on the tunables (#380, #304, #305): a change with a reason, shown
// old and new before it is sent, tried the wrong way beside a control that
// does the same thing rightly.

const ADMIN = "3c9d0f5e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const CONFIG = "/admin/config";
const CHANGE = /^\/admin\/config\/[a-z0-9_]+$/;

const version = (n: number, value: unknown) => ({
  version: n,
  value,
  validFrom: `2026-10-0${n}T09:30:00.000Z`,
  createdBy: "migration",
  reason: null,
});
const feedback = {
  key: "feedback_per_day",
  value: 5,
  version: 1,
  versions: [version(1, 5)],
};
const inbox = { key: "inbox_stop", value: 30, version: 1, versions: [version(1, 30)] };
const listOf = (...items: unknown[]) => json({ items });
/** What the API answers a change with: the key and the row it wrote. */
const wrote = (key: string, value: number) => ({
  key,
  version: 2,
  value,
  validFrom: "2026-10-09T09:30:00.000Z",
  createdBy: ADMIN,
  reason: "Pilot week two",
});
const failure = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const keyOf = (request: Request) => new URL(request.url).pathname.split("/").at(-1) ?? "";

/** One key's item in the list, found by its name. */
async function item(key: string) {
  const name = await screen.findByText(key, { selector: "code" });
  return within(name.closest("li") as HTMLElement);
}
/** Types a value and a reason into one key's form and asks for the review. */
function review(at: ReturnType<typeof within>, value: string, reason = "Pilot week two") {
  fireEvent.change(at.getByLabelText("New value"), { target: { value } });
  fireEvent.change(at.getByLabelText("Why the change"), { target: { value: reason } });
  fireEvent.click(at.getByRole("button", { name: "Review the change" }));
}
const lines = () =>
  screen.getAllByRole("listitem").map((li) => li.querySelector("summary")?.textContent);

async function settle() {
  for (let turn = 0; turn < 3; turn++) await settled();
}

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter>
        <ConfigList />
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The form submitted with its button left out of it, as Enter in the value field would. */
async function submittedWithReason(reason: string) {
  const sent = network([
    on("GET", CONFIG, () => listOf(feedback)),
    on("POST", CHANGE, () => json(wrote("feedback_per_day", 6))),
  ]);
  show();
  const at = await item("feedback_per_day");
  fireEvent.change(at.getByLabelText("New value"), { target: { value: "6" } });
  fireEvent.change(at.getByLabelText("Why the change"), { target: { value: reason } });
  fireEvent.submit(at.getByLabelText("New value").closest("form") as HTMLFormElement);
  await settle();
  const apply = at.queryByRole("button", { name: "Change it" });
  if (apply) fireEvent.click(apply);
  await settle();
  return { offered: apply !== null, changes: sentTo(sent, "POST", CHANGE).length };
}

// admin.config.reason: the reason field "is required (#305)".
attack(
  "ConfigList: a change goes out with a reason of only spaces when the form is submitted without its button",
  {
    // Goes through today: the review asks only the value; a browser does not submit this form, and the API refuses the empty reason.
    open: QUESTION,
    attempt: () => submittedWithReason("   "),
    control: () => submittedWithReason("Pilot week two"),
    succeeds: (seen) => expect(seen.changes).toBe(1),
  },
);

/** One key's change fails while the other key's change is shown for review. */
async function failedBeside(failing: "feedback_per_day" | "inbox_stop") {
  const answer = held();
  const other = failing === "feedback_per_day" ? "inbox_stop" : "feedback_per_day";
  network([
    on("GET", CONFIG, () => listOf(feedback, inbox)),
    on("POST", `/admin/config/${failing}`, () => answer.promise),
  ]);
  show();
  const failingAt = await item(failing);
  review(failingAt, "6");
  fireEvent.click(failingAt.getByRole("button", { name: "Change it" }));
  review(await item(other), "9", "Another week");
  answer.answer(failure("internal_error", 500));
  await settle();
  return (await item("inbox_stop")).queryByRole("alert") !== null;
}

attack(
  "ConfigList: one key's failed change is said on another key, whose change is shown for review",
  {
    attempt: () => failedBeside("feedback_per_day"),
    control: () => failedBeside("inbox_stop"),
    succeeds: (saidOnInbox) => expect(saidOnInbox).toBe(true),
  },
);

/** Both keys changed at once, the second key's answer first. */
async function changedInReverse(values: Record<"feedback_per_day" | "inbox_stop", number>) {
  const answers: Record<string, Held> = { feedback_per_day: held(), inbox_stop: held() };
  network([
    on("GET", CONFIG, () => listOf(feedback, inbox)),
    on("POST", CHANGE, (request) => (answers[keyOf(request)] as Held).promise),
  ]);
  show();
  for (const key of ["feedback_per_day", "inbox_stop"] as const) {
    const at = await item(key);
    review(at, String(values[key]));
    fireEvent.click(at.getByRole("button", { name: "Change it" }));
  }
  await settle();
  answers.inbox_stop?.answer(json(wrote("inbox_stop", values.inbox_stop)));
  await settle();
  answers.feedback_per_day?.answer(json(wrote("feedback_per_day", values.feedback_per_day)));
  await settle();
  return lines();
}

attack("ConfigList: two changes answered in reverse order show each key the other's value", {
  attempt: () => changedInReverse({ feedback_per_day: 7, inbox_stop: 9 }),
  control: () => changedInReverse({ feedback_per_day: 9, inbox_stop: 7 }),
  succeeds: (summaries) => expect(summaries).toEqual(["feedback_per_day 9", "inbox_stop 7"]),
});

/** Change it pressed, and pressed again: while the first is out, or after it came back failed and was reviewed again. */
async function changedTwice(firstFailedBefore: boolean) {
  const first = held();
  let posts = 0;
  const sent = network([
    on("GET", CONFIG, () => listOf(feedback)),
    on("POST", CHANGE, () => (posts++ === 0 ? first.promise : json(wrote("feedback_per_day", 6)))),
  ]);
  show();
  const at = await item("feedback_per_day");
  review(at, "6");
  fireEvent.click(at.getByRole("button", { name: "Change it" }));
  if (firstFailedBefore) {
    first.answer(failure("internal_error", 500));
    await at.findByRole("alert");
    fireEvent.click(at.getByRole("button", { name: "Review the change" }));
  }
  fireEvent.click(at.getByRole("button", { name: "Change it" }));
  await settle();
  return sentTo(sent, "POST", CHANGE).length;
}

attack("ConfigList: Change it pressed again while the first change is out sends a second one", {
  attempt: () => changedTwice(false),
  control: () => changedTwice(true),
  succeeds: (changes) => expect(changes).toBeGreaterThan(1),
});
