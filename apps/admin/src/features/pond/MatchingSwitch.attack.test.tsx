import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource } from "../../lib/api.ts";
import { attack } from "../../test/attack.ts";
import { held, json, network, on, sentTo, settled } from "../../test/network.ts";
import { MatchingSwitch } from "./MatchingSwitch.tsx";

// What goes through today (#380): a hole, which its contract forbids, and a question, where no line says what should happen.
const HOLE = "#380";
const QUESTION = "#380, a question";

// Attacks on the switch that opens matching (#380, #500, ADR-060): its read
// and its press through a confirm step, tried the wrong way beside a control
// that does the same thing rightly.

const SUOMI = "3c9d0f5e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const PONDS = "/admin/ponds";
const PRESS = `/admin/ponds/${SUOMI}/matching`;

const pond = (matchingOpen: boolean) => ({ id: SUOMI, slug: "suomi", name: "Suomi", matchingOpen });
const closedPond = () => json({ items: [pond(false)] });
const failure = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

const step = () => screen.getByRole("dialog");
/** The press on the card, which opens the step; then the step's own button. */
const openStep = async () =>
  fireEvent.click(await screen.findByRole("button", { name: "Open matching" }));
const confirm = () =>
  fireEvent.click(within(step()).getByRole("button", { name: "Open matching" }));

async function settle() {
  for (let turn = 0; turn < 3; turn++) await settled();
}

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter>
        <MatchingSwitch />
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function listRefused(status: number) {
  network([
    on("GET", PONDS, () => failure(status === 403 ? "admin_forbidden" : "internal_error", status)),
  ]);
  show();
  await settle();
  return screen.queryByRole("alert")?.textContent ?? null;
}

// rules/admin.md: a 403 is said once by the shell, never as the screen's own failure.
attack("MatchingSwitch: a refused list (403) is said as the screen's own failure", {
  attempt: () => listRefused(403),
  control: () => listRefused(500),
  succeeds: (said) => expect(said).toBe("Could not be loaded."),
});

async function listUnanswered(failsOutright: boolean) {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const answer = held();
  network([on("GET", PONDS, () => answer.promise)]);
  show();
  await settle();
  if (failsOutright) answer.fail();
  await settle();
  return screen.queryByText("Loading…") !== null;
}

attack("MatchingSwitch: a list request that fails outright leaves the switch loading for good", {
  attempt: () => listUnanswered(true),
  control: () => listUnanswered(false),
  succeeds: (busy) => expect(busy).toBe(true),
});

/** A press, Cancel, and the press again: while the first is out, or after it came back failed. */
async function pressedAgainAfterCancel(firstFailedBefore: boolean) {
  const first = held();
  let presses = 0;
  const sent = network([
    on("GET", PONDS, closedPond),
    on("POST", PRESS, () => (presses++ === 0 ? first.promise : json(pond(true)))),
  ]);
  show();
  await openStep();
  confirm();
  if (firstFailedBefore) {
    first.answer(failure("internal_error", 500));
    await within(step()).findByRole("alert");
  }
  fireEvent.click(within(step()).getByRole("button", { name: "Cancel" }));
  // Only a closed step lets the person reach the card's press again.
  if (screen.queryByRole("dialog") === null) {
    await openStep();
    confirm();
  }
  await settle();
  return sentTo(sent, "POST", PRESS).length;
}

attack(
  "MatchingSwitch: a second press goes out while the first is still out, through Cancel and a new step",
  {
    // Goes through today: the one-at-a-time guard is each step's own, and Cancel starts a new step while the first press is out.
    open: QUESTION,
    attempt: () => pressedAgainAfterCancel(false),
    control: () => pressedAgainAfterCancel(true),
    succeeds: (presses) => expect(presses).toBe(2),
  },
);

/** Cancel pressed in the step: with the press out, or before anything was sent. */
async function cancelled(whileOut: boolean) {
  const press = held();
  network([on("GET", PONDS, closedPond), on("POST", PRESS, () => press.promise)]);
  show();
  await openStep();
  if (whileOut) {
    confirm();
    await settle();
  }
  fireEvent.click(within(step()).getByRole("button", { name: "Cancel" }));
  await settle();
  const closed = screen.queryByRole("dialog") === null;
  // What comes after, for the report: the answer still turns the switch and says so.
  press.answer(json(pond(true)));
  await settle();
  const said = document.querySelector("p[aria-live='polite']")?.textContent;
  return { closed, badge: screen.queryByText(/^(Open|Closed)$/)?.textContent, said };
}

// admin.matching.cancel: "leaves the confirm step with nothing changed".
attack("MatchingSwitch: Cancel closes the step while the press it cannot take back is still out", {
  // Goes through today: Cancel stays enabled while the press is out, and the closed step's answer still lands.
  open: HOLE,
  attempt: () => cancelled(true),
  control: () => cancelled(false),
  succeeds: (seen) => expect(seen.closed).toBe(true),
});

async function pressFailing(failsOutright: boolean) {
  const press = held();
  network([on("GET", PONDS, closedPond), on("POST", PRESS, () => press.promise)]);
  show();
  await openStep();
  confirm();
  await settle();
  if (failsOutright) press.fail();
  await settle();
  return screen.queryByText("That did not go through. Nothing was changed.") !== null;
}

attack("MatchingSwitch: a press that fails outright says nothing", {
  attempt: () => pressFailing(true),
  control: () => pressFailing(false),
  succeeds: (said) => expect(said).toBe(false),
});

/** The switch turned from the keyboard; the control then plants the lost focus itself. */
async function turnedByKeyboard(blurredAfter: boolean) {
  network([on("GET", PONDS, closedPond), on("POST", PRESS, () => json(pond(true)))]);
  show();
  const press = await screen.findByRole("button", { name: "Open matching" });
  press.focus();
  fireEvent.click(press);
  confirm();
  await screen.findByText("Open");
  if (blurredAfter) (document.activeElement as HTMLElement | null)?.blur();
  await settle();
  return document.activeElement === document.body;
}

// rules/admin.md: the confirm step gives the focus back.
attack(
  "MatchingSwitch: the focus falls to the page's body after the switch is turned from the keyboard",
  {
    attempt: () => turnedByKeyboard(false),
    control: () => turnedByKeyboard(true),
    succeeds: (onBody) => expect(onBody).toBe(true),
  },
);
