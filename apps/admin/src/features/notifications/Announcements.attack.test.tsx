import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource } from "../../lib/api.ts";
import { attack } from "../../test/attack.ts";
import { held, json, network, on, sentTo, settled } from "../../test/network.ts";
import { Announcements } from "./Announcements.tsx";

// Attacks on the announcements (#380, #573, ADR-068): the draft, the second
// admin's approval that sends it to everybody, and the deletion, tried the
// wrong way beside a control that does the same thing rightly.

const EN = { title: "A short break on Sunday", body: "Kuutti is closed from 10 to 12." };
const FI = { title: "Lyhyt tauko sunnuntaina", body: "Kuutti on suljettu kello 10–12." };
const SV = { title: "Ett kort avbrott på söndag", body: "Kuutti är stängd klockan 10–12." };
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const announcement = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  en: EN,
  fi: FI,
  sv: null,
  writtenAt: "2026-11-07T10:00:00.000Z",
  approvedAt: null,
  yours: false,
  ...over,
});
const SENT_AT = "2026-11-07T11:00:00.000Z";

const LIST = "/admin/announcements";
const APPROVE = `/admin/announcements/${id(1)}/approve`;
const listOf = (...items: unknown[]) =>
  json({ items, reach: { accounts: 120, phones: 1, addresses: 40 } });
const failure = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

const field = (legend: string, label: "Title" | "Text") =>
  within(screen.getByRole("group", { name: legend })).getByLabelText(label) as HTMLInputElement;
function fill(legend: string, words: { title: string; body: string }) {
  fireEvent.change(field(legend, "Title"), { target: { value: words.title } });
  fireEvent.change(field(legend, "Text"), { target: { value: words.body } });
}
const saveButton = () => screen.getByRole("button", { name: "Save for a second admin" });
const step = () => screen.getByRole("dialog");
/** The screen's live line, where what the last act did is said. */
const said = () => document.querySelector("p[aria-live='polite']")?.textContent ?? "";

async function settle() {
  for (let turn = 0; turn < 3; turn++) await settled();
}

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter>
        <Announcements />
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

async function saveRefused(status: number) {
  network([
    on("GET", LIST, () => listOf()),
    on("POST", LIST, () => failure(status === 403 ? "admin_forbidden" : "internal_error", status)),
  ]);
  show();
  await screen.findByText("Nothing is waiting.");
  fill("English", EN);
  fill("Finnish", FI);
  fireEvent.click(saveButton());
  await settle();
  return screen.queryByRole("alert")?.textContent ?? null;
}

// rules/admin.md: a 403 is said once by the shell, never as the screen's own failure.
attack("Announcements: a refused draft (403) is said as the form's own failure", {
  attempt: () => saveRefused(403),
  control: () => saveRefused(500),
  succeeds: (failure) => expect(failure).toBe("That did not go through. Try again."),
});

/** An announcement written out, then Refresh, whose list fails; or Save, which empties the form rightly. */
async function writtenThen(press: "Refresh" | "Save") {
  let loads = 0;
  network([
    on("GET", LIST, () => (loads++ === 0 ? listOf() : failure("internal_error", 500))),
    on("POST", LIST, () => json(announcement(4, { yours: true }), 201)),
  ]);
  show();
  await screen.findByText("Nothing is waiting.");
  fill("English", EN);
  fill("Finnish", FI);
  if (press === "Refresh") fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  else fireEvent.click(saveButton());
  await settle();
  return screen.queryByDisplayValue(EN.title) === null;
}

attack("Announcements: a refresh that fails throws away the announcement being written", {
  attempt: () => writtenThen("Refresh"),
  control: () => writtenThen("Save"),
  succeeds: (gone) => expect(gone).toBe(true),
});

/** Enter in the form, then a click on Save: while the first is out, or after it came back failed. */
async function savedTwice(firstFailedBefore: boolean) {
  const first = held();
  let posts = 0;
  const sent = network([
    on("GET", LIST, () => listOf()),
    on("POST", LIST, () =>
      posts++ === 0 ? first.promise : json(announcement(4, { yours: true }), 201),
    ),
  ]);
  show();
  await screen.findByText("Nothing is waiting.");
  fill("English", EN);
  fill("Finnish", FI);
  fireEvent.submit(saveButton().closest("form") as HTMLFormElement);
  if (firstFailedBefore) {
    first.answer(failure("internal_error", 500));
    await screen.findByRole("alert");
  }
  fireEvent.click(saveButton());
  await settle();
  return sentTo(sent, "POST", LIST).length;
}

attack("Announcements: Enter and then a click on Save, while the first is out, write two drafts", {
  attempt: () => savedTwice(false),
  control: () => savedTwice(true),
  succeeds: (drafts) => expect(drafts).toBeGreaterThan(1),
});

/** A save that fails, with the English title changed while it was out, or left as it was. */
async function failedWhileTyping(typedMeanwhile: boolean) {
  const answer = held();
  network([on("GET", LIST, () => listOf()), on("POST", LIST, () => answer.promise)]);
  show();
  await screen.findByText("Nothing is waiting.");
  fill("English", EN);
  fill("Finnish", FI);
  fireEvent.click(saveButton());
  await settle();
  if (typedMeanwhile) {
    fireEvent.change(field("English", "Title"), { target: { value: "A longer break on Sunday" } });
  }
  answer.answer(failure("internal_error", 500));
  await settle();
  return field("English", "Title").value;
}

attack(
  "Announcements: a draft that fails to save puts back the words typed after Save was pressed",
  {
    attempt: () => failedWhileTyping(true),
    control: () => failedWhileTyping(false),
    succeeds: (title) => expect(title).toBe(EN.title),
  },
);

/** A save that goes through, with Swedish typed while it was out, or none. */
async function savedWhileTyping(typedMeanwhile: boolean) {
  const answer = held();
  network([on("GET", LIST, () => listOf()), on("POST", LIST, () => answer.promise)]);
  show();
  await screen.findByText("Nothing is waiting.");
  fill("English", EN);
  fill("Finnish", FI);
  fireEvent.click(saveButton());
  await settle();
  if (typedMeanwhile) fill("Swedish, if you write it", SV);
  answer.answer(json(announcement(4, { yours: true }), 201));
  await settle();
  return field("Swedish, if you write it", "Title").value;
}

attack(
  "Announcements: a saved draft empties the Swedish typed after Save was pressed, which was never sent",
  {
    attempt: () => savedWhileTyping(true),
    control: () => savedWhileTyping(false),
    succeeds: (swedish) => expect(swedish).toBe(""),
  },
);

const steps = {
  approval: {
    opens: "Approve and send",
    applies: "Send to everybody",
    method: "POST",
    path: APPROVE,
    done: () => json(announcement(1, { approvedAt: SENT_AT })),
  },
  deletion: {
    opens: "Delete",
    applies: "Delete the draft",
    method: "DELETE",
    path: `${LIST}/${id(1)}`,
    done: () => new Response(null, { status: 204 }),
  },
};

// admin.announcements.cancel: "closes an announcement's confirm step with nothing done".
for (const [what, s] of Object.entries(steps)) {
  const cancelled = async (whileOut: boolean) => {
    const answer = held();
    network([
      on("GET", LIST, () => listOf(announcement(1))),
      on(s.method, s.path, () => answer.promise),
    ]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: s.opens }));
    if (whileOut) {
      fireEvent.click(within(step()).getByRole("button", { name: s.applies }));
      await settle();
    }
    fireEvent.click(within(step()).getByRole("button", { name: "Cancel" }));
    await settle();
    const closed = screen.queryByRole("dialog") === null;
    // What comes after, for the report: the answer still lands, and is said.
    answer.answer(s.done());
    await settle();
    return { closed, said: said() };
  };
  attack(
    `Announcements: Cancel closes the ${what} step while the request it cannot take back is out`,
    {
      attempt: () => cancelled(true),
      control: () => cancelled(false),
      succeeds: (seen) => expect(seen.closed).toBe(true),
    },
  );
}

async function approvalFailing(failsOutright: boolean) {
  const answer = held();
  network([
    on("GET", LIST, () => listOf(announcement(1))),
    on("POST", APPROVE, () => answer.promise),
  ]);
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Approve and send" }));
  fireEvent.click(within(step()).getByRole("button", { name: "Send to everybody" }));
  await settle();
  if (failsOutright) answer.fail();
  await settle();
  return screen.queryByText("That did not go through. Try again.") !== null;
}

attack("Announcements: an approval that fails outright says nothing", {
  attempt: () => approvalFailing(true),
  control: () => approvalFailing(false),
  succeeds: (saidSo) => expect(saidSo).toBe(false),
});

/**
 * Approve and send opened from the keyboard, then one more press: on whatever
 * the step put the focus on (a second Enter), or on Send to everybody chosen.
 */
async function pressedInStep(target: "what has the focus" | "Send to everybody") {
  const sent = network([
    on("GET", LIST, () => listOf(announcement(1))),
    on("POST", APPROVE, () => json(announcement(1, { approvedAt: SENT_AT }))),
  ]);
  show();
  const approve = await screen.findByRole("button", { name: "Approve and send" });
  approve.focus();
  fireEvent.click(approve);
  const pressed =
    target === "what has the focus"
      ? (document.activeElement as HTMLElement)
      : within(step()).getByRole("button", { name: "Send to everybody" });
  fireEvent.click(pressed);
  await settle();
  return sentTo(sent, "POST", APPROVE).length;
}

// admin.announcements.confirmSend.effect: "Nothing takes it back."
attack(
  "Announcements: one more Enter after opening the sending step sends the announcement to everybody",
  {
    attempt: () => pressedInStep("what has the focus"),
    control: () => pressedInStep("Send to everybody"),
    succeeds: (approvals) => expect(approvals).toBe(1),
  },
);

/** An announcement sent from the keyboard; the control then plants the lost focus itself. */
async function sentByKeyboard(blurredAfter: boolean) {
  network([
    on("GET", LIST, () => listOf(announcement(1))),
    on("POST", APPROVE, () => json(announcement(1, { approvedAt: SENT_AT }))),
  ]);
  show();
  const approve = await screen.findByRole("button", { name: "Approve and send" });
  approve.focus();
  fireEvent.click(approve);
  fireEvent.click(within(step()).getByRole("button", { name: "Send to everybody" }));
  await screen.findByText("Sent to everybody.");
  if (blurredAfter) (document.activeElement as HTMLElement | null)?.blur();
  await settle();
  return document.activeElement === document.body;
}

// rules/admin.md: the confirm step gives the focus back.
attack(
  "Announcements: the focus falls to the page's body after an announcement is sent from the keyboard",
  {
    attempt: () => sentByKeyboard(false),
    control: () => sentByKeyboard(true),
    succeeds: (onBody) => expect(onBody).toBe(true),
  },
);

async function draftAfterAccessReturns(saved: boolean) {
  let reads = 0;
  network([
    on("GET", LIST, () => (++reads === 2 ? failure("admin_forbidden", 403) : listOf())),
    on("POST", LIST, () => json(announcement(4, { yours: true }), 201)),
  ]);
  show();
  await screen.findByText("Nothing is waiting.");
  fill("English", EN);
  fill("Finnish", FI);
  if (saved) {
    fireEvent.click(saveButton());
    await settle();
  }
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await settle();
  expect(screen.queryByRole("group", { name: "English" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Nothing is waiting.");
  return field("English", "Title").value;
}
attack("Announcements: a temporary forbidden refresh loses unsaved words when access returns", {
  attempt: () => draftAfterAccessReturns(false),
  control: () => draftAfterAccessReturns(true),
  succeeds: (title) => expect(title).toBe(""),
});
