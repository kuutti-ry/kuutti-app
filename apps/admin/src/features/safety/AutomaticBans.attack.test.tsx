import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setRoleAnswerHandler, setTokenSource } from "../../lib/api.ts";
import { attack } from "../../test/attack.ts";
import { held, json, network, on, sentTo, settled } from "../../test/network.ts";
import { AutomaticBans } from "./AutomaticBans.tsx";

// What goes through today (#380): a question, where no line says what should happen.
const QUESTION = "#380, a question";

// Attacks on the automatic shadow bans (#380, #105): the list's read, on
// opening and on Refresh, and Confirm and Reverse, #307's second look with the
// decision fixed by the button pressed. Each tries what must not happen and
// stays green while that fails; its control does the same thing rightly.

const NOW = "2031-03-09T12:00:00.000Z";
const STAFF = "a1b2c3d4-9a8e-4a0b-9c3a-0c8d1e2f3a99";
const hex = (n: number) => n.toString(16).padStart(2, "0");
const LIST = "/admin/sanctions/automatic";

/** A rule's ban: three people's reports, the ban two hours old. */
const ban = (n: number) => ({
  id: `5a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${hex(n)}`,
  accountId: `${hex(n)}1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b`,
  rule: "reports",
  count: 3,
  firstAt: "2031-03-08T06:00:00.000Z",
  createdAt: "2031-03-09T10:00:00.000Z",
});
type Ban = ReturnType<typeof ban>;
const queue = (items: Ban[]) => ({ now: NOW, reviewHours: 48, items, total: items.length });
/** What the review route answers: the sanction, kept or lifted, with the reviewer's note. */
const reviewed = (item: Ban, outcome: "keep" | "lift") => ({
  id: item.id,
  accountId: item.accountId,
  kind: "shadow_ban",
  reason: "other",
  note: "Applied by an automatic rule.",
  endsAt: null,
  createdBy: null,
  createdAt: item.createdAt,
  liftedAt: outcome === "lift" ? NOW : null,
  liftedBy: outcome === "lift" ? STAFF : null,
  reviewNote: "Three reports in an hour",
  reviewedBy: STAFF,
  reviewedAt: NOW,
});
const failure = (status: number, code: string) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const reviewOf = (item: Ban) => `/admin/sanctions/${item.id}/review`;

type Reply = () => Response | Promise<Response>;
/** Each request the next answer of the list, the last one again after that. */
function inTurn(...replies: Reply[]) {
  let n = 0;
  return () => {
    const reply = replies[Math.min(n, replies.length - 1)];
    n += 1;
    if (!reply) throw new Error("no answer given");
    return reply();
  };
}
/** Lets a chain of answers finish: the request, its body, the state it sets. */
async function drain() {
  for (let turn = 0; turn < 3; turn += 1) await settled();
}
/** A request the network fails outright: no status, no body. */
const lost = () => {
  const answer = held();
  answer.fail();
  return answer.promise;
};

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter initialEntries={["/automatic-bans"]}>
        <Routes>
          <Route path="/automatic-bans" element={<AutomaticBans />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

const refresh = () => fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
const alerts = () => screen.queryAllByRole("alert").map((alert) => alert.textContent);
const button = (scope: HTMLElement, name: string) => within(scope).getByRole("button", { name });
/** Whether the line of `item` is on the list. */
const listed = (item: Ban) =>
  screen.queryByRole("link", { name: `Account ${item.accountId.slice(0, 8)}` }) !== null;
const dialogSays = () => {
  const open = screen.queryByRole("dialog");
  return open ? (within(open).queryByRole("alert")?.textContent ?? null) : null;
};
/** Presses a line's Confirm or Reverse as a keyboard does, and writes the note unless told not to. */
async function openDecision(name: "Confirm" | "Reverse", item: Ban, note = true) {
  const link = await screen.findByRole("link", { name: `Account ${item.accountId.slice(0, 8)}` });
  const opener = button(link.closest("li") as HTMLElement, name);
  opener.focus();
  fireEvent.click(opener);
  const step = screen.getByRole("dialog");
  if (note) {
    fireEvent.change(within(step).getByRole("textbox", { name: "Your note" }), {
      target: { value: "Three reports in an hour" },
    });
  }
  return step;
}

beforeEach(() => {
  setTokenSource(() => "t".repeat(43));
  // The failures below are logged on purpose; the console stays quiet.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setRoleAnswerHandler(() => undefined);
});

// The list's read.

/** Opens the list, presses Refresh twice, both held; the one named first lists ban 2, the other, last, ban 3. */
async function refreshedTwice(first: "older" | "newer") {
  const older = held();
  const newer = held();
  const sent = network([
    on(
      "GET",
      LIST,
      inTurn(
        () => json(queue([ban(1)])),
        () => older.promise,
        () => newer.promise,
      ),
    ),
  ]);
  show();
  await screen.findByText("1 waiting");
  refresh();
  refresh();
  await settled();
  if (sentTo(sent, "GET", LIST).length !== 3) throw new Error("both refreshes not sent");
  const [early, late] = first === "older" ? [older, newer] : [newer, older];
  early.answer(json(queue([ban(2)])));
  await drain();
  late.answer(json(queue([ban(3)])));
  await drain();
  return listed(ban(3));
}

attack(
  "AutomaticBans: the first refresh's answer, arriving after the second's, is what the list shows",
  {
    attempt: () => refreshedTwice("newer"),
    control: () => refreshedTwice("older"),
    succeeds: (thirdListed) => expect(thirdListed).toBe(true),
  },
);

/** Opens the list on one ban, then presses Refresh, answered as given. */
async function refreshedInto(second: Reply) {
  network([
    on(
      "GET",
      LIST,
      inTurn(() => json(queue([ban(1)])), second),
    ),
  ]);
  show();
  await screen.findByText("1 waiting");
  refresh();
  await drain();
  return alerts();
}

attack("AutomaticBans: a refresh that fails after a good load says nothing of it", {
  attempt: () => refreshedInto(() => failure(500, "internal_error")),
  control: () => refreshedInto(() => json(queue([ban(2)]))),
  succeeds: (said) => expect(said).toEqual([]),
});

attack("AutomaticBans: a refresh refused with 403 is said as the screen's own failure", {
  attempt: () => refreshedInto(() => failure(403, "admin_forbidden")),
  control: () => refreshedInto(() => failure(500, "internal_error")),
  succeeds: (said) => expect(said).toContain("Could not be loaded."),
});

/** Opens the list, its first read answered as given. */
async function opened(first: Reply) {
  network([on("GET", LIST, first)]);
  show();
  await drain();
  return alerts();
}

attack("AutomaticBans: a first load whose network fails outright says nothing of it", {
  attempt: () => opened(lost),
  control: () => opened(() => json(queue([]))),
  succeeds: (said) => expect(said).toEqual([]),
});

// Confirm and Reverse.

/** Presses the step's Confirm twice, the first answered as given. */
async function confirmTwice(first: Reply) {
  const item = ban(1);
  const sent = network([
    on("GET", LIST, () => json(queue([item]))),
    on(
      "POST",
      reviewOf(item),
      inTurn(first, () => held().promise),
    ),
  ]);
  show();
  const confirm = button(await openDecision("Confirm", item), "Confirm");
  fireEvent.click(confirm);
  await drain();
  fireEvent.click(confirm);
  await drain();
  return sentTo(sent, "POST", reviewOf(item)).length;
}

attack("AutomaticBans: Confirm pressed twice sends two decisions", {
  attempt: () => confirmTwice(() => held().promise),
  // Failed before the second press: sending again is right.
  control: () => confirmTwice(() => failure(500, "internal_error")),
  succeeds: (decisions) => expect(decisions).toBe(2),
});

/** Confirms the first line (held), cancels, reverses the second (held); answers the one named. */
async function twoDecisions(answered: "first" | "second", reply: (item: Ban) => Response) {
  const one = ban(1);
  const two = ban(2);
  const first = held();
  const second = held();
  network([
    on("GET", LIST, () => json(queue([one, two]))),
    on("POST", reviewOf(one), () => first.promise),
    on("POST", reviewOf(two), () => second.promise),
  ]);
  show();
  const step = await openDecision("Confirm", one);
  fireEvent.click(button(step, "Confirm"));
  await settled();
  fireEvent.click(button(step, "Cancel"));
  fireEvent.click(button(await openDecision("Reverse", two), "Reverse"));
  await settled();
  if (answered === "first") first.answer(reply(one));
  else second.answer(reply(two));
  await drain();
  return {
    stepOpen: screen.queryByRole("dialog") !== null,
    said: dialogSays(),
    secondListed: listed(two),
  };
}

attack(
  "AutomaticBans: one line's decision, refused after the moderator went on to another line's, is said in that step",
  {
    attempt: () => twoDecisions("first", () => failure(409, "sanction_reviewed")),
    control: () => twoDecisions("second", () => failure(409, "sanction_reviewed")),
    succeeds: ({ said }) => expect(said).toBe("Somebody looked at it again already."),
  },
);

attack(
  "AutomaticBans: one line's decision, answered after the moderator went on to another line's, closes that step",
  {
    // Goes through today: a cancelled step's late answer closes whatever step is open.
    open: QUESTION,
    attempt: () => twoDecisions("first", (item) => json(reviewed(item, "keep"))),
    control: () => twoDecisions("second", (item) => json(reviewed(item, "lift"))),
    succeeds: ({ stepOpen }) => expect(stepOpen).toBe(false),
  },
);

attack(
  "AutomaticBans: one line's decision, answered while another line's is out, takes the other line off the list",
  {
    attempt: () => twoDecisions("first", (item) => json(reviewed(item, "keep"))),
    control: () => twoDecisions("second", (item) => json(reviewed(item, "lift"))),
    succeeds: ({ secondListed }) => expect(secondListed).toBe(false),
  },
);

/** Confirms, never answered; cancels; confirms again, its note written or not. */
async function lostThenAgain(note: boolean) {
  const item = ban(1);
  const sent = network([
    on("GET", LIST, () => json(queue([item]))),
    on("POST", reviewOf(item), () => held().promise),
  ]);
  show();
  const first = await openDecision("Confirm", item);
  fireEvent.click(button(first, "Confirm"));
  await settled();
  fireEvent.click(button(first, "Cancel"));
  fireEvent.click(button(await openDecision("Confirm", item, note), "Confirm"));
  await drain();
  return sentTo(sent, "POST", reviewOf(item)).length;
}

attack("AutomaticBans: a decision that never answers leaves no way to send it again", {
  attempt: () => lostThenAgain(true),
  // The second step has no note: nothing goes, rightly.
  control: () => lostThenAgain(false),
  succeeds: (decisions) => expect(decisions).toBe(1),
});

/** Writes a note in Reverse and cancels; opens Confirm on the same line, its note written or not, and presses it. */
async function cancelledThenConfirmed(note: boolean) {
  const item = ban(1);
  const sent = network([
    on("GET", LIST, () => json(queue([item]))),
    on("POST", reviewOf(item), () => json(reviewed(item, "keep"))),
  ]);
  show();
  fireEvent.click(button(await openDecision("Reverse", item), "Cancel"));
  fireEvent.click(button(await openDecision("Confirm", item, note), "Confirm"));
  await drain();
  return sentTo(sent, "POST", reviewOf(item)).length;
}

attack("AutomaticBans: the note of a cancelled step stays, so Confirm goes without one written", {
  attempt: () => cancelledThenConfirmed(false),
  control: () => cancelledThenConfirmed(true),
  succeeds: (decisions) => expect(decisions).toBe(1),
});
