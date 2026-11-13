import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setRoleAnswerHandler, setTokenSource } from "../../lib/api.ts";
import { StaffRole } from "../../lib/role.ts";
import { attack } from "../../test/attack.ts";
import { held, json, network, on, pathOf, sentTo, settled } from "../../test/network.ts";
import { AccountPage } from "./AccountPage.tsx";

// What goes through today (#380): a hole, which its contract forbids, and a question, where no line says what should happen.
const HOLE = "#380";
const QUESTION = "#380, a question";

// Attacks on a person's page (#380, #306), its sanctions (#308) and its
// take-downs (#477): the reads (the page, its sanctions, both read again after
// an action) and the writes (warn and the other applies, lift, the second
// look, take down). Each tries what must not happen and stays green while
// that fails; its control does the same thing rightly.

const A = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const B = "7a2d2d5f-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const STAFF = "a1b2c3d4-9a8e-4a0b-9c3a-0c8d1e2f3a99";
const THEN = "2026-10-10T09:00:00.000Z";
const hex = (n: number) => n.toString(16).padStart(2, "0");
const photoId = (n: number) => `0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${hex(n)}`;

const photo = (n: number, state = "approved") => ({
  id: photoId(n),
  state,
  rejectionReason: state === "rejected" ? "nudity" : null,
  appealable: false,
  uploadedAt: THEN,
});
/** A person's page: active, in good standing, named `name`, with the photos given. */
const page = (id: string, name = "Aino", photos: unknown[] = []) => ({
  id,
  state: "active",
  stateChangedAt: null,
  registeredAt: THEN,
  deletedAt: null,
  standing: "ok",
  standingChangedAt: null,
  suspensionEndsAt: null,
  age: 34,
  gender: "woman",
  profile: { displayName: name, bio: null, bioPreset: null, prompts: [], fields: {} },
  photos,
  feedback: [],
  audit: [],
});
/** A sanction as the list gives it, open, a moderator's; a sanction route answers it too (the roles are stripped). */
const entry = (n: number, kind: string, note: string) => ({
  id: `5a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${hex(n)}`,
  accountId: A,
  kind,
  reason: "harassment",
  note,
  endsAt: kind === "suspend" ? "2026-10-31T22:00:00.000Z" : null,
  createdBy: STAFF,
  createdAt: THEN,
  liftedAt: null,
  liftedBy: null,
  reviewNote: null,
  reviewedBy: null,
  reviewedAt: null,
  createdByRole: "moderator",
  liftedByRole: null,
  reviewedByRole: null,
});
const OPEN = entry(1, "suspend", "Wrote something unkind in two chats");
const WARNED = entry(2, "warn", "Asked for a phone number at once");
const WARN_NOTE = "Spam links in every chat";
const HIDE_NOTE = "Opened two hundred cards a minute";
const lifted = (item: ReturnType<typeof entry>) => ({ ...item, liftedAt: THEN, liftedBy: STAFF });
const decided = (n: number) => ({
  photoId: photoId(n),
  state: "rejected",
  rejectionReason: "nudity",
});

const failure = (status: number, code: string) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const PAGE = `/admin/accounts/${A}`;
const LIST = `/admin/accounts/${A}/sanctions`;
const liftOf = (item: { id: string }) => `/admin/sanctions/${item.id}/lift`;
const reviewOf = (item: { id: string }) => `/admin/sanctions/${item.id}/review`;
const decideOf = (n: number) => `/admin/photos/${photoId(n)}/decision`;

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
/** The page itself and its sanctions, answered as given unless the attack says more. */
const person = (photos: unknown[] = [], items: unknown[] = []) => [
  on("GET", PAGE, () => json(page(A, "Aino", photos))),
  on("GET", LIST, () => json({ items })),
];

/** The page at A's address, inside the role the shell gives, with a link that moves the address to B's. */
function show() {
  render(
    <I18nProvider i18n={i18n}>
      <StaffRole.Provider value="moderator">
        <MemoryRouter initialEntries={[`/accounts/${A}`]}>
          <Link to={`/accounts/${B}`}>the next person</Link>
          <Routes>
            <Route path="/accounts/:id" element={<AccountPage />} />
          </Routes>
        </MemoryRouter>
      </StaffRole.Provider>
    </I18nProvider>,
  );
}

const nameShown = () =>
  screen.queryByText("Name", { selector: "dt" })?.nextElementSibling?.textContent ?? null;
const alerts = () => screen.queryAllByRole("alert").map((alert) => alert.textContent);
const dialogSays = () => {
  const open = screen.queryByRole("dialog");
  return open ? (within(open).queryByRole("alert")?.textContent ?? null) : null;
};
const statusOfSanctions = () =>
  within(
    screen.getByRole("heading", { level: 3, name: "Sanctions" }).parentElement as HTMLElement,
  ).getByRole("status").textContent;

/** Presses a button as a keyboard does, so the step gives the focus back to it; the step opened. */
function press(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
  return screen.getByRole("dialog");
}
const button = (scope: HTMLElement, name: string) => within(scope).getByRole("button", { name });
/** Opens Warn or Shadow ban and fills it: the reason unless told not to, and the note. */
async function openApply(action: "Warn" | "Shadow ban", note = WARN_NOTE, reason = true) {
  const group = await screen.findByRole("group", { name: "Actions on this person" });
  const step = press(button(group, action));
  if (reason) {
    fireEvent.change(within(step).getByRole("combobox", { name: "Reason" }), {
      target: { value: "harassment" },
    });
  }
  fireEvent.change(within(step).getByRole("textbox", { name: "Note" }), {
    target: { value: note },
  });
  return step;
}
/** A row of the sanctions' history, by its note; waits for the list. */
const rowOf = async (note: string) =>
  (await screen.findByText(note, { selector: "li > p" })).closest("li") as HTMLElement;
/** One photo's box on the page, in the page's order; waits for the page. */
async function photoBox(at: number) {
  const title = await screen.findByRole("heading", { level: 3, name: "Photos" });
  const box = within(title.parentElement as HTMLElement).getAllByRole("listitem")[at];
  if (!box) throw new Error(`no photo ${at}`);
  return box;
}
/** Opens the take-down of the photo at `at`, a reason chosen unless told not to. */
async function openTakeDown(at: number, reason = true) {
  const step = press(button(await photoBox(at), "Take down…"));
  if (reason) {
    fireEvent.change(within(step).getByRole("combobox", { name: "Reason the person is told" }), {
      target: { value: "nudity" },
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

// R1: another id in the address. The same page stays on screen when the
// address moves from one person to another (browser history does it).

/** Opens A's page, both pages' reads held, and moves to B's; the one answered first is named Kaisa, the last Aino. */
async function movedOn(last: "A" | "B") {
  const reads = new Map([
    [A, held()],
    [B, held()],
  ]);
  const read = (id: string) => {
    const answer = reads.get(id);
    if (!answer) throw new Error(`no read for ${id}`);
    return answer;
  };
  const sent = network([
    on("GET", /^\/admin\/accounts\/[^/]+$/, (request) => read(pathOf(request).slice(16)).promise),
    on("GET", /\/sanctions$/, () => json({ items: [] })),
  ]);
  show();
  await settled();
  fireEvent.click(screen.getByRole("link", { name: "the next person" }));
  await settled();
  if (sentTo(sent, "GET", /^\/admin\/accounts\/[^/]+$/).length !== 2) {
    throw new Error("both pages not asked for");
  }
  const [early, late] = last === "A" ? [B, A] : [A, B];
  read(early).answer(json(page(early, "Kaisa")));
  await drain();
  read(late).answer(json(page(late, "Aino")));
  await drain();
  return { title: screen.getByRole("heading", { level: 2 }).textContent, name: nameShown() };
}

attack(
  "AccountPage: the first person's page, answered after the second's, is shown under the second's title",
  {
    // Goes through today: the page sets what a read answers without asking whether it is still for the id in the address (no panel link reaches it yet).
    open: HOLE,
    attempt: () => movedOn("A"),
    control: () => movedOn("B"),
    succeeds: ({ name }) => expect(name).toBe("Aino"),
  },
);

/** Applies a warning, then a shadow ban while the first read again is out; both lists held, the last answered with the warning alone. */
async function appliedTwice(last: "first" | "second") {
  const first = held();
  const second = held();
  const warned = entry(3, "warn", WARN_NOTE);
  const hidden = entry(4, "shadow_ban", HIDE_NOTE);
  const sent = network([
    on("GET", PAGE, () => json(page(A))),
    on(
      "GET",
      LIST,
      inTurn(
        () => json({ items: [] }),
        () => first.promise,
        () => second.promise,
      ),
    ),
    on(
      "POST",
      LIST,
      inTurn(
        () => json(warned, 201),
        () => json(hidden, 201),
      ),
    ),
  ]);
  show();
  fireEvent.click(button(await openApply("Warn"), "Apply"));
  await drain();
  fireEvent.click(button(await openApply("Shadow ban", HIDE_NOTE), "Apply"));
  await drain();
  if (sentTo(sent, "GET", LIST).length !== 3) throw new Error("not read again twice");
  const [early, late] = last === "first" ? [second, first] : [first, second];
  early.answer(json({ items: [hidden, warned] }));
  await drain();
  late.answer(json({ items: [warned] }));
  await drain();
  return screen.queryByText(HIDE_NOTE) !== null;
}

attack(
  "AccountPage: the first read after an action, answered after the second's, takes the newer sanction off the history",
  {
    // Goes through today: the reads after an action keep no order.
    open: QUESTION,
    attempt: () => appliedTwice("first"),
    control: () => appliedTwice("second"),
    succeeds: (hiddenListed) => expect(hiddenListed).toBe(false),
  },
);

// R2, R3, R6: the reads failing.

/** Applies a warning; the page's read after it is answered as given. */
async function warnedThenRead(again: Reply) {
  network([
    on(
      "GET",
      PAGE,
      inTurn(() => json(page(A)), again),
    ),
    on("GET", LIST, () => json({ items: [] })),
    on("POST", LIST, () => json(entry(3, "warn", WARN_NOTE), 201)),
  ]);
  show();
  fireEvent.click(button(await openApply("Warn"), "Apply"));
  await drain();
  return alerts();
}

attack(
  "AccountPage: reading the page again after a warning fails, and nothing on the page says so",
  {
    // Goes through today: a failed read of the page after an action is kept quiet, by design, unlike the list's.
    open: QUESTION,
    attempt: () => warnedThenRead(() => failure(500, "internal_error")),
    control: () => warnedThenRead(() => json(page(A))),
    succeeds: (said) => expect(said).toEqual([]),
  },
);

/** Opens the page, its two reads answered as given. */
async function opened(pageReply: Reply, listReply: Reply) {
  network([on("GET", PAGE, pageReply), on("GET", LIST, listReply)]);
  show();
  await drain();
  return { name: nameShown(), said: alerts() };
}

attack("AccountPage: a sanctions list that never answers keeps the whole page from showing", {
  // Goes through today: the page waits for the list before it shows anything.
  open: QUESTION,
  attempt: () =>
    opened(
      () => json(page(A)),
      () => held().promise,
    ),
  // The page's own read never answers: nothing to show, rightly.
  control: () =>
    opened(
      () => held().promise,
      () => json({ items: [] }),
    ),
  succeeds: ({ name }) => expect(name).toBeNull(),
});

attack("AccountPage: a sanctions list refused with 403 is said as the page's own failure", {
  // Goes through today: a refused list is read as a failed one.
  open: HOLE,
  attempt: () =>
    opened(
      () => json(page(A)),
      () => failure(403, "admin_forbidden"),
    ),
  control: () =>
    opened(
      () => json(page(A)),
      () => failure(500, "internal_error"),
    ),
  succeeds: ({ said }) => expect(said).toContain("Could not be loaded."),
});

// A1: a write that already went through, offered and sent again while the
// page is read again after it.

/** Lifts the open suspension, the first lift answered as given; the read after it never lands; then Lift again where offered. */
async function liftedThenAgain(firstLift: Reply) {
  const sent = network([
    on("GET", PAGE, () => json(page(A))),
    on(
      "GET",
      LIST,
      inTurn(
        () => json({ items: [OPEN] }),
        () => held().promise,
      ),
    ),
    on(
      "POST",
      liftOf(OPEN),
      inTurn(firstLift, () => held().promise),
    ),
  ]);
  show();
  fireEvent.click(button(press(button(await rowOf(OPEN.note), "Lift")), "Lift"));
  await drain();
  if (screen.queryByRole("dialog")) throw new Error("the step did not close");
  const again = within(await rowOf(OPEN.note)).queryByRole("button", { name: "Lift" });
  if (again) fireEvent.click(button(press(again), "Lift"));
  await drain();
  return sentTo(sent, "POST", liftOf(OPEN)).length;
}

attack(
  "Sanctions: a lift is sent again while the page is read again after the first went through",
  {
    // Goes through today: what went through is offered again until the page is read again.
    open: QUESTION,
    attempt: () => liftedThenAgain(() => json(lifted(OPEN))),
    // Refused, left to the shell: nothing was lifted, so lifting again is right.
    control: () => liftedThenAgain(() => failure(403, "admin_forbidden")),
    succeeds: (lifts) => expect(lifts).toBe(2),
  },
);

/** Takes the first photo down, answered as given; the read after it never lands; then Take down again where offered. */
async function takenDownThenAgain(first: Reply) {
  const sent = network([
    on(
      "GET",
      PAGE,
      inTurn(
        () => json(page(A, "Aino", [photo(1), photo(2)])),
        () => held().promise,
      ),
    ),
    on("GET", LIST, () => json({ items: [] })),
    on(
      "POST",
      decideOf(1),
      inTurn(first, () => held().promise),
    ),
  ]);
  show();
  fireEvent.click(button(await openTakeDown(0), "Take down"));
  await drain();
  if (screen.queryByRole("dialog")) throw new Error("the step did not close");
  if (within(await photoBox(0)).queryByRole("button", { name: "Take down…" })) {
    fireEvent.click(button(await openTakeDown(0), "Take down"));
  }
  await drain();
  return sentTo(sent, "POST", decideOf(1)).length;
}

attack(
  "TakeDown: a take-down is sent again while the page is read again after the first went through",
  {
    // Goes through today: what went through is offered again until the page is read again.
    open: QUESTION,
    attempt: () => takenDownThenAgain(() => json(decided(1))),
    // Refused, left to the shell: the photo is still approved, so taking it down again is right.
    control: () => takenDownThenAgain(() => failure(403, "admin_forbidden")),
    succeeds: (takeDowns) => expect(takeDowns).toBe(2),
  },
);

// A2: pressed twice.

/** Fills Warn, sends it by Enter, then clicks Apply; the first answered as given. */
async function enterThenClick(first: Reply) {
  const sent = network([
    ...person(),
    on(
      "POST",
      LIST,
      inTurn(first, () => held().promise),
    ),
  ]);
  show();
  const step = await openApply("Warn");
  fireEvent.submit(step.querySelector("form") as HTMLFormElement);
  await drain();
  fireEvent.click(button(step, "Apply"));
  await drain();
  return sentTo(sent, "POST", LIST).length;
}

attack("Sanctions: a warning sent by Enter and then a click goes out twice", {
  attempt: () => enterThenClick(() => held().promise),
  // Refused before the click: sending again is right.
  control: () => enterThenClick(() => failure(409, "staff_target")),
  succeeds: (warnings) => expect(warnings).toBe(2),
});

/** Presses Take down twice, the first answered as given. */
async function takeDownTwice(first: Reply) {
  const sent = network([
    ...person([photo(1)]),
    on(
      "POST",
      decideOf(1),
      inTurn(first, () => held().promise),
    ),
  ]);
  show();
  const confirm = button(await openTakeDown(0), "Take down");
  fireEvent.click(confirm);
  await drain();
  fireEvent.click(confirm);
  await drain();
  return sentTo(sent, "POST", decideOf(1)).length;
}

attack("TakeDown: Take down pressed twice sends two take-downs", {
  attempt: () => takeDownTwice(() => held().promise),
  // Failed before the second press: sending again is right.
  control: () => takeDownTwice(() => failure(500, "internal_error")),
  succeeds: (takeDowns) => expect(takeDowns).toBe(2),
});

// A3, A4: a step cancelled while its write is out, and another opened.

/** Lifts the suspension (held), cancels, lifts the warning (held); answers the one named. */
async function twoLifts(answered: "first" | "second", reply: (item: typeof OPEN) => Response) {
  const first = held();
  const second = held();
  network([
    ...person([], [OPEN, WARNED]),
    on("POST", liftOf(OPEN), () => first.promise),
    on("POST", liftOf(WARNED), () => second.promise),
  ]);
  show();
  const one = press(button(await rowOf(OPEN.note), "Lift"));
  fireEvent.click(button(one, "Lift"));
  await settled();
  fireEvent.click(button(one, "Cancel"));
  fireEvent.click(button(press(button(await rowOf(WARNED.note), "Lift")), "Lift"));
  await settled();
  if (answered === "first") first.answer(reply(OPEN));
  else second.answer(reply(WARNED));
  await drain();
  return { said: dialogSays(), status: statusOfSanctions() };
}

attack(
  "Sanctions: one row's lift, refused after the moderator went on to another row's, is said in that row's step",
  {
    attempt: () => twoLifts("first", () => failure(409, "sanction_lifted")),
    control: () => twoLifts("second", () => failure(409, "sanction_lifted")),
    succeeds: ({ said }) => expect(said).toBe("It is lifted already."),
  },
);

attack(
  "Sanctions: one row's lift, answered while another row's is out, is said with the other's kind",
  {
    attempt: () => twoLifts("first", (item) => json(lifted(item))),
    control: () => twoLifts("second", (item) => json(lifted(item))),
    succeeds: ({ status }) => expect(status).toBe("Lifted: Warning."),
  },
);

/** Sends Warn (held), cancels, sends Shadow ban (held); answers the one named. */
async function twoApplies(answered: "first" | "second") {
  const first = held();
  const second = held();
  network([
    ...person(),
    on(
      "POST",
      LIST,
      inTurn(
        () => first.promise,
        () => second.promise,
      ),
    ),
  ]);
  show();
  const warn = await openApply("Warn");
  fireEvent.click(button(warn, "Apply"));
  await settled();
  fireEvent.click(button(warn, "Cancel"));
  fireEvent.click(button(await openApply("Shadow ban", HIDE_NOTE), "Apply"));
  await settled();
  if (answered === "first") first.answer(json(entry(3, "warn", WARN_NOTE), 201));
  else second.answer(json(entry(4, "shadow_ban", HIDE_NOTE), 201));
  await drain();
  return screen.queryByRole("dialog") !== null;
}

attack(
  "Sanctions: a warning cancelled while out, answered later, closes the shadow ban's step opened since",
  {
    // Goes through today: a cancelled step's late answer closes whatever step is open.
    open: QUESTION,
    attempt: () => twoApplies("first"),
    control: () => twoApplies("second"),
    succeeds: (stillOpen) => expect(stillOpen).toBe(false),
  },
);

/** Takes the first photo down (held), cancels, takes the second down (held); answers the one named. */
async function twoTakeDowns(answered: "first" | "second", reply: (n: number) => Response) {
  const first = held();
  const second = held();
  network([
    ...person([photo(1), photo(2)]),
    on("POST", decideOf(1), () => first.promise),
    on("POST", decideOf(2), () => second.promise),
  ]);
  show();
  const one = await openTakeDown(0);
  fireEvent.click(button(one, "Take down"));
  await settled();
  fireEvent.click(button(one, "Cancel"));
  fireEvent.click(button(await openTakeDown(1), "Take down"));
  await settled();
  if (answered === "first") first.answer(reply(1));
  else second.answer(reply(2));
  await drain();
  return { stepOpen: screen.queryByRole("dialog") !== null, said: dialogSays() };
}

attack(
  "TakeDown: one photo's take-down, refused after the moderator went on to the next photo's, is said in that step",
  {
    attempt: () => twoTakeDowns("first", () => failure(409, "photo_not_approved")),
    control: () => twoTakeDowns("second", () => failure(409, "photo_not_approved")),
    succeeds: ({ said }) =>
      expect(said).toBe(
        "The photo is no longer approved: it was taken down meanwhile. Reload the page to see it as it is.",
      ),
  },
);

attack(
  "TakeDown: one photo's take-down, answered after the moderator went on to the next photo's, closes that step",
  {
    attempt: () => twoTakeDowns("first", (n) => json(decided(n))),
    control: () => twoTakeDowns("second", (n) => json(decided(n))),
    succeeds: ({ stepOpen }) => expect(stepOpen).toBe(false),
  },
);

// A5: no answer.

/** Sends Warn, which never answers; cancels; opens Warn again, its reason chosen or not, and presses Apply. */
async function lostThenAgain(reason: boolean) {
  const sent = network([...person(), on("POST", LIST, () => held().promise)]);
  show();
  const first = await openApply("Warn");
  fireEvent.click(button(first, "Apply"));
  await settled();
  fireEvent.click(button(first, "Cancel"));
  fireEvent.click(button(await openApply("Warn", WARN_NOTE, reason), "Apply"));
  await drain();
  return sentTo(sent, "POST", LIST).length;
}

attack("Sanctions: a warning that never answers leaves no way to send one again", {
  attempt: () => lostThenAgain(true),
  // The second step lacks its reason: nothing goes, rightly.
  control: () => lostThenAgain(false),
  succeeds: (warnings) => expect(warnings).toBe(1),
});

// A6: a decision by default, a choice left from the step before.

/** Applies a warning, then opens Warn again, the reason chosen or not, and presses Apply. */
async function warnedThenAgain(reason: boolean) {
  const sent = network([
    ...person(),
    on("POST", LIST, () => json(entry(3, "warn", WARN_NOTE), 201)),
  ]);
  show();
  fireEvent.click(button(await openApply("Warn"), "Apply"));
  await drain();
  fireEvent.click(button(await openApply("Warn", WARN_NOTE, reason), "Apply"));
  await drain();
  return sentTo(sent, "POST", LIST).length;
}

attack("Sanctions: the last warning's reason stays chosen, so the next goes without one chosen", {
  attempt: () => warnedThenAgain(false),
  control: () => warnedThenAgain(true),
  succeeds: (warnings) => expect(warnings).toBe(2),
});

/** Takes the first photo down, then the second, its reason chosen or not. */
async function takenDownThenNext(reason: boolean) {
  let current = page(A, "Aino", [photo(1), photo(2)]);
  const sent = network([
    on("GET", PAGE, () => json(current)),
    on("GET", LIST, () => json({ items: [] })),
    on("POST", decideOf(1), () => {
      current = page(A, "Aino", [photo(1, "rejected"), photo(2)]);
      return json(decided(1));
    }),
    on("POST", decideOf(2), () => json(decided(2))),
  ]);
  show();
  fireEvent.click(button(await openTakeDown(0), "Take down"));
  await drain();
  fireEvent.click(button(await openTakeDown(1, reason), "Take down"));
  await drain();
  return sentTo(sent, "POST", decideOf(2)).length;
}

attack("TakeDown: the reason chosen for one photo stays chosen, so the next goes without one", {
  attempt: () => takenDownThenNext(false),
  control: () => takenDownThenNext(true),
  succeeds: (takeDowns) => expect(takeDowns).toBe(1),
});

/** Looks again at the suspension, kept; then at the warning, its decision chosen or not. */
async function reviewedThenNext(decide: boolean) {
  const sent = network([
    ...person([], [OPEN, WARNED]),
    on("POST", reviewOf(OPEN), () => json(OPEN)),
    on("POST", reviewOf(WARNED), () => json(WARNED)),
  ]);
  show();
  const review = async (note: string, keep: boolean) => {
    const step = press(button(await rowOf(note), "Look at it again"));
    fireEvent.change(within(step).getByRole("textbox", { name: "Your note" }), {
      target: { value: "Fair, as it stands" },
    });
    if (keep) fireEvent.click(within(step).getByRole("radio", { name: "Keep it" }));
    fireEvent.click(button(step, "Apply"));
    await drain();
  };
  await review(OPEN.note, true);
  await review(WARNED.note, decide);
  return sentTo(sent, "POST", reviewOf(WARNED)).length;
}

attack("Sanctions: the last second look's decision stays chosen, so the next goes without one", {
  attempt: () => reviewedThenNext(false),
  control: () => reviewedThenNext(true),
  succeeds: (reviews) => expect(reviews).toBe(1),
});

// A7: what is said afterwards.

/** Takes the photo down, answered as given; the page's read after it fails. */
async function takenDownReadFails(decision: Reply) {
  network([
    on(
      "GET",
      PAGE,
      inTurn(
        () => json(page(A, "Aino", [photo(1)])),
        () => failure(500, "internal_error"),
      ),
    ),
    on("GET", LIST, () => json({ items: [] })),
    on("POST", decideOf(1), decision),
  ]);
  show();
  fireEvent.click(button(await openTakeDown(0), "Take down"));
  await drain();
  return screen.queryByText("Taken down.") !== null;
}

attack("TakeDown: a take-down that went through is not said when reading the page again fails", {
  attempt: () => takenDownReadFails(() => json(decided(1))),
  // Refused: nothing was taken down, and nothing says it was.
  control: () => takenDownReadFails(() => failure(409, "photo_not_approved")),
  succeeds: (said) => expect(said).toBe(false),
});
