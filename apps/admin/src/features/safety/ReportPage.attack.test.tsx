import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setRoleAnswerHandler, setTokenSource } from "../../lib/api.ts";
import { StaffRole } from "../../lib/role.ts";
import { attack } from "../../test/attack.ts";
import { held, json, network, on, pathOf, sentTo, settled } from "../../test/network.ts";
import { ReportPage } from "./ReportPage.tsx";

// Attacks on one report (#380, #312): its read, once per visit; the photos
// of its copy and the photo it points at, each fetched on request; and its
// writes (a sanction applied here, closing with a sanction, dismissing,
// taking the pointed photo down). Each tries what must not happen and stays
// green while that fails; its control does the same thing rightly.

const ID = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";
const NEXT = "9c2d2d5f-9a8e-4a0b-9c3a-0c8d1e2f3a02";
const REPORTER = "1b0e0e3a-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const REPORTED = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const STAFF = "a1b2c3d4-9a8e-4a0b-9c3a-0c8d1e2f3a99";
const PHOTO = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3aff";
const FILED = "2026-10-10T09:00:00.000Z";
const said = (minute: number) => `2026-10-09T21:${String(minute).padStart(2, "0")}:00.000Z`;

/** A conversation's report, waiting: a text, a photo held at line 3, nothing pointed at. */
const detail = (extra: Record<string, unknown> = {}) => ({
  id: ID,
  reason: "harassment",
  source: "conversation",
  createdAt: FILED,
  outcome: null,
  decidedAt: null,
  reporter: { accountId: REPORTER, filed: 1, upheld: 0 },
  reported: { accountId: REPORTED, received: 1, sanctions: 0 },
  note: "He kept writing after I said no.",
  decidedBy: null,
  sanctionId: null,
  copy: [
    { seq: 1, side: "reporter", kind: "text", body: "Hi!", photo: false, createdAt: said(1) },
    { seq: 3, side: "reported", kind: "photo", body: null, photo: true, createdAt: said(3) },
  ],
  lineSeq: null,
  pointedPhoto: null,
  actable: [],
  ...extra,
});
/** A card's report pointing at an approved photo of the person reported. */
const cardReport = () =>
  detail({
    source: "card",
    copy: null,
    pointedPhoto: { removed: false, id: PHOTO, state: "approved", approvedPhotos: 3 },
  });
const sanction = (n: number) => ({
  id: `5a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${n.toString(16).padStart(2, "0")}`,
  accountId: REPORTED,
  kind: "warn",
  reason: "harassment",
  note: "Kept writing after a no",
  endsAt: null,
  createdBy: STAFF,
  createdAt: "2026-10-11T08:30:00.000Z",
  liftedAt: null,
  liftedBy: null,
  reviewNote: null,
  reviewedBy: null,
  reviewedAt: null,
});
const actable = (n: number) => {
  const { id, kind, reason, createdAt, liftedAt } = sanction(n);
  return { id, kind, reason, createdAt, liftedAt };
};
const decision = (outcome: "dismissed" | "acted", sanctionId: string | null = null) => ({
  id: ID,
  outcome,
  decidedAt: "2026-10-12T16:20:00.000Z",
  decidedBy: STAFF,
  sanctionId,
});
const fullUrl = (id: string) => ({
  url: `https://media.test/media/${id}/full.webp?Signature=s`,
  variant: "full",
  expiresAt: "2030-01-01T00:00:00.000Z",
});

const failure = (status: number, code: string) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const REPORT = `/admin/reports/${ID}`;
const DECISION = `${REPORT}/decision`;
const SANCTIONS = `/admin/accounts/${REPORTED}/sanctions`;
const POINTED = `${REPORT}/photo`;
const TAKE_DOWN = `/admin/photos/${PHOTO}/decision`;
const ONE_REPORT = /^\/admin\/reports\/[^/]+$/;
/** The report a request's path names. */
const reportOf = (request: Request) => pathOf(request).split("/")[3] ?? "";

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
/** A decision's outcome, read from the request's body. */
const outcomeOf = async (request: Request) =>
  ((await request.clone().json()) as { outcome: string }).outcome;

/** The report at its path, inside the role the shell gives, with a link that moves the address to the next report. */
function show() {
  render(
    <I18nProvider i18n={i18n}>
      <StaffRole.Provider value="moderator">
        <MemoryRouter initialEntries={[`/reports/${ID}`]}>
          <Link to={`/reports/${NEXT}`}>the next report</Link>
          <Routes>
            <Route path="/reports/:id" element={<ReportPage />} />
          </Routes>
        </MemoryRouter>
      </StaffRole.Provider>
    </I18nProvider>,
  );
}

const loaded = () => screen.findByRole("heading", { level: 3, name: "Decision" });
const button = (scope: HTMLElement, name: string) => within(scope).getByRole("button", { name });
/** Presses a button as a keyboard does, so the step gives the focus back to it; the step opened. */
function press(opener: HTMLElement) {
  opener.focus();
  fireEvent.click(opener);
  return screen.getByRole("dialog");
}
const alerts = () => screen.queryAllByRole("alert").map((alert) => alert.textContent);
const dialogSays = () => {
  const open = screen.queryByRole("dialog");
  return open ? (within(open).queryByRole("alert")?.textContent ?? null) : null;
};
const photoCard = () =>
  screen.getByRole("heading", { level: 3, name: "The photo the reporter pointed at" })
    .parentElement as HTMLElement;

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
// address moves from one report to another (browser history does it).

/** Opens the report, its read held, and moves to the next; the read named first answers with the note "Note one", the other with "Note two". */
async function movedOn(first: "opened" | "next") {
  const reads = new Map([
    [ID, held()],
    [NEXT, held()],
  ]);
  const read = (id: string) => {
    const answer = reads.get(id);
    if (!answer) throw new Error(`no read for ${id}`);
    return answer;
  };
  const sent = network([on("GET", ONE_REPORT, (request) => read(reportOf(request)).promise)]);
  show();
  await settled();
  fireEvent.click(screen.getByRole("link", { name: "the next report" }));
  await settled();
  if (sentTo(sent, "GET", ONE_REPORT).length !== 2) throw new Error("both reports not asked for");
  const [early, late] = first === "opened" ? [ID, NEXT] : [NEXT, ID];
  read(early).answer(json(detail({ id: early, note: "Note one" })));
  await drain();
  read(late).answer(json(detail({ id: late, note: "Note two" })));
  await drain();
  return {
    title: screen.getByRole("heading", { level: 2 }).textContent,
    note: document.querySelector("blockquote")?.textContent ?? null,
  };
}

attack(
  "ReportPage: the first report's answer, arriving after the address moved on to the next, is shown under the next one's title",
  {
    attempt: () => movedOn("opened"),
    control: () => movedOn("next"),
    succeeds: ({ note }) => expect(note).toBe("Note one"),
  },
);

/** Asks for the copy's photo on the first report (held), moves to the next and asks there (held); answers the one named. */
async function photosAcrossMove(answered: "first" | "next") {
  const first = held();
  const next = held();
  network([
    on("GET", ONE_REPORT, (request) => json(detail({ id: reportOf(request) }))),
    on("GET", `${REPORT}/copy/3/photo`, () => first.promise),
    on("GET", `/admin/reports/${NEXT}/copy/3/photo`, () => next.promise),
  ]);
  show();
  await loaded();
  fireEvent.click(screen.getByRole("button", { name: "Show photo" }));
  await settled();
  fireEvent.click(screen.getByRole("link", { name: "the next report" }));
  await loaded();
  fireEvent.click(screen.getByRole("button", { name: "Show photo" }));
  await settled();
  if (answered === "first") first.answer(json(fullUrl(ID)));
  else next.answer(json(fullUrl(NEXT)));
  await drain();
  return screen.queryByRole("img") !== null;
}

attack(
  "ReportPage: the first report's photo, answered after the address moved on, shows on the next report's page",
  {
    attempt: () => photosAcrossMove("first"),
    control: () => photosAcrossMove("next"),
    succeeds: (shown) => expect(shown).toBe(true),
  },
);

// R6: a refusal the shell says.

/** Asks for the photo a card's report points at, answered as given. */
async function pointedPhoto(reply: Reply) {
  network([on("GET", REPORT, () => json(cardReport())), on("GET", POINTED, reply)]);
  show();
  await loaded();
  fireEvent.click(button(photoCard(), "Show photo"));
  await drain();
  return alerts();
}

attack("ReportPage: the pointed photo refused with 403 is said as the page's own failure", {
  attempt: () => pointedPhoto(() => failure(403, "admin_forbidden")),
  control: () => pointedPhoto(() => failure(500, "internal_error")),
  succeeds: (alerted) => expect(alerted).toContain("The photo could not be shown."),
});

// A1: a decision sent after the report was already decided.

/** Sends Warn (held), cancels, dismisses the report, answered as given; then the warning's 201 arrives. */
async function warnedAfterDismissal(allowCancel: boolean) {
  const warning = held();
  const sent = network([
    on("GET", REPORT, () => json(detail())),
    on("POST", SANCTIONS, () => warning.promise),
    // Closing with the warning: refused as decided, which it is once dismissed.
    on("POST", DECISION, async (request) =>
      (await outcomeOf(request)) === "dismissed"
        ? json(decision("dismissed"))
        : failure(409, "report_decided"),
    ),
  ]);
  show();
  const act = await screen.findByRole("group", { name: "Act on the reported person" });
  const warn = press(button(act, "Warn"));
  fireEvent.change(within(warn).getByRole("combobox", { name: "Reason" }), {
    target: { value: "harassment" },
  });
  fireEvent.change(within(warn).getByRole("textbox", { name: /^Note/ }), {
    target: { value: "Kept writing after a no" },
  });
  fireEvent.click(button(warn, "Apply"));
  await settled();
  if (allowCancel) {
    warning.answer(failure(500, "internal_error"));
    await drain();
  }
  fireEvent.click(button(warn, "Cancel"));
  if (screen.queryByRole("dialog")) return 0;
  fireEvent.click(button(press(screen.getByRole("button", { name: "Dismiss" })), "Dismiss report"));
  await drain();
  warning.answer(json(sanction(1), 201));
  await drain();
  return sentTo(sent, "POST", DECISION).length;
}

attack("ReportPage: a report can be dismissed while its warning is still being applied", {
  attempt: () => warnedAfterDismissal(false),
  // The dismissal failed: the report still waits, and closing it with the warning is right.
  control: () => warnedAfterDismissal(true),
  succeeds: (decisions) => expect(decisions).toBeGreaterThan(0),
});

// A3: a decision failing after the moderator went on to another step.

/** Dismisses (held), cancels, closes with the listed sanction (held); fails the one named. */
async function dismissedThenClosed(failing: "dismissal" | "closing") {
  const dismissal = held();
  const closing = held();
  network([
    on("GET", REPORT, () => json(detail({ actable: [actable(2)] }))),
    on("POST", DECISION, async (request) =>
      (await outcomeOf(request)) === "dismissed" ? dismissal.promise : closing.promise,
    ),
  ]);
  show();
  await loaded();
  const dismiss = press(screen.getByRole("button", { name: "Dismiss" }));
  fireEvent.click(button(dismiss, "Dismiss report"));
  await settled();
  if (failing === "closing") {
    dismissal.answer(failure(500, "internal_error"));
    await drain();
  }
  fireEvent.click(button(dismiss, "Cancel"));
  if (screen.queryByRole("dialog")) return null;
  fireEvent.click(
    button(press(screen.getByRole("button", { name: "Close with this" })), "Close report"),
  );
  await settled();
  (failing === "dismissal" ? dismissal : closing).answer(failure(500, "internal_error"));
  await drain();
  return dialogSays();
}

attack(
  "ReportPage: a dismissal failing after the moderator went on to close the report is said in that step",
  {
    attempt: () => dismissedThenClosed("dismissal"),
    control: () => dismissedThenClosed("closing"),
    succeeds: (alerted) => expect(alerted).toBe("The decision could not be saved."),
  },
);

// A5: no answer.

/** Dismisses, the answer as given; cancels the step if it is still open, then dismisses again if Dismiss is offered. */
async function dismissedTwice(first: Reply) {
  const sent = network([
    on("GET", REPORT, () => json(detail())),
    on(
      "POST",
      DECISION,
      inTurn(first, () => held().promise),
    ),
  ]);
  show();
  await loaded();
  fireEvent.click(button(press(screen.getByRole("button", { name: "Dismiss" })), "Dismiss report"));
  await drain();
  const open = screen.queryByRole("dialog");
  if (open) fireEvent.click(button(open, "Cancel"));
  const again = screen.queryByRole("button", { name: "Dismiss" });
  if (again && !screen.queryByRole("dialog"))
    fireEvent.click(button(press(again), "Dismiss report"));
  await drain();
  return sentTo(sent, "POST", DECISION).length;
}

attack("ReportPage: cancelling a dismissal with an unknown outcome lets it be sent again", {
  attempt: () => dismissedTwice(() => held().promise),
  control: () => dismissedTwice(() => failure(500, "internal_error")),
  succeeds: (decisions) => expect(decisions).toBeGreaterThan(1),
});

// A7: where the focus goes after the step.

/** Takes the pointed photo down, answered as given; whether the focus is back on Take down…. */
async function takenDown(reply: Reply) {
  network([on("GET", REPORT, () => json(cardReport())), on("POST", TAKE_DOWN, reply)]);
  show();
  await loaded();
  const opener = button(photoCard(), "Take down…");
  const step = press(opener);
  fireEvent.change(within(step).getByRole("combobox", { name: "Reason the person is told" }), {
    target: { value: "other" },
  });
  fireEvent.click(button(step, "Take down"));
  await drain();
  return {
    onOpener: document.activeElement === opener,
    stepOpen: screen.queryByRole("dialog") !== null,
  };
}

attack("ReportPage: a take-down refused with 403 does not give the focus back to Take down…", {
  attempt: () => takenDown(() => failure(403, "admin_forbidden")),
  // Taken down: the button goes with the change, and the photo's line has the focus.
  control: () =>
    takenDown(() => json({ photoId: PHOTO, state: "rejected", rejectionReason: "other" })),
  succeeds: ({ onOpener }) => expect(onOpener).toBe(false),
});
