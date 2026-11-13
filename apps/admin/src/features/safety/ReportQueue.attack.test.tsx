import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setRoleAnswerHandler, setTokenSource } from "../../lib/api.ts";
import { attack } from "../../test/attack.ts";
import { held, json, network, on, sentTo, settled } from "../../test/network.ts";
import { ReportQueue } from "./ReportQueue.tsx";

// Attacks on the report queue's read (#380, #311): GET /admin/reports, once
// per filter, Waiting for a decision or Decided, and on Refresh. Each tries
// what the read must not do and stays green while that fails; its control
// does the same thing rightly.

const NOW = "2031-03-09T12:00:00.000Z";
const X = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const Y = "7a2d2d5f-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const A = "1b0e0e3a-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const REPORTS = "/admin/reports";

/** A report waiting, about `about`, filed two hours before the API's now. */
const report = (n: number, about: string, extra: Record<string, unknown> = {}) => ({
  id: `0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${n.toString(16).padStart(2, "0")}`,
  reason: "harassment",
  source: "card",
  createdAt: "2031-03-09T10:00:00.000Z",
  outcome: null,
  decidedAt: null,
  reporter: { accountId: A, filed: 1, upheld: 0 },
  reported: { accountId: about, received: 1, sanctions: 0 },
  ...extra,
});
const page = (items: unknown[]) => ({ now: NOW, responseHours: 24, items, total: items.length });
const failure = (status: number, code: string) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const stateOf = (request: Request) => new URL(request.url).searchParams.get("state");

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

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter initialEntries={["/reports"]}>
        <Routes>
          <Route path="/reports" element={<ReportQueue />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

const choose = (name: "Decided" | "Waiting for a decision") =>
  fireEvent.click(screen.getByRole("radio", { name }));
/** Whether the box of the person `about` is on screen. */
const boxOf = (about: string) =>
  screen.queryByRole("link", { name: `About account ${about.slice(0, 8)}` }) !== null;
const alerts = () => screen.queryAllByRole("alert").map((alert) => alert.textContent);

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

/**
 * Opens the queue, chooses Decided, then Waiting again, both answers held;
 * the one named first gets a page about X, the other, last, a page about Y.
 * Waiting is chosen at the end: its own answer is the one to show.
 */
async function switchedBack(first: "decided" | "waiting") {
  const decided = held();
  const waiting = held();
  const opens = inTurn(
    () => json(page([report(1, X)])),
    () => waiting.promise,
  );
  const sent = network([
    on("GET", REPORTS, (request) => (stateOf(request) === "closed" ? decided.promise : opens())),
  ]);
  show();
  await screen.findByText("1 waiting");
  choose("Decided");
  await settled();
  choose("Waiting for a decision");
  await settled();
  if (sentTo(sent, "GET", REPORTS).length !== 3) throw new Error("both lists not asked for");
  const [early, late] = first === "decided" ? [decided, waiting] : [waiting, decided];
  early.answer(json(page([report(2, X)])));
  await drain();
  late.answer(json(page([report(3, Y)])));
  await drain();
  return boxOf(Y);
}

attack(
  "ReportQueue: the decided list, answered after Waiting was chosen again, is shown under Waiting",
  {
    attempt: () => switchedBack("waiting"),
    control: () => switchedBack("decided"),
    succeeds: (decidedShown) => expect(decidedShown).toBe(true),
  },
);

/** Opens the queue on a report about X, then chooses Decided, answered as given. */
async function decidedAnswered(closed: Reply) {
  network([
    on("GET", REPORTS, (request) =>
      stateOf(request) === "closed" ? closed() : json(page([report(1, X)])),
    ),
  ]);
  show();
  await screen.findByText("1 waiting");
  choose("Decided");
  await drain();
  return { xShown: boxOf(X), said: alerts() };
}

attack(
  "ReportQueue: Decided failing after a good load leaves the waiting reports on screen under it",
  {
    attempt: () => decidedAnswered(() => failure(500, "internal_error")),
    // A decided report about the same person: the box is rightly there.
    control: () =>
      decidedAnswered(() => json(page([report(2, X, { outcome: "dismissed", decidedAt: NOW })]))),
    succeeds: ({ xShown }) => expect(xShown).toBe(true),
  },
);

attack("ReportQueue: Decided refused with 403 is said as the screen's own failure", {
  attempt: () => decidedAnswered(() => failure(403, "admin_forbidden")),
  control: () => decidedAnswered(() => failure(500, "internal_error")),
  succeeds: ({ said }) => expect(said).toContain("Could not be loaded."),
});

/** Opens the queue, its first read answered as given. */
async function opened(first: Reply) {
  network([on("GET", REPORTS, first)]);
  show();
  await drain();
  return alerts();
}

/** A request the network fails outright: no status, no body. */
const lost = () => {
  const answer = held();
  answer.fail();
  return answer.promise;
};

attack("ReportQueue: a first load whose network fails outright says nothing of it", {
  attempt: () => opened(lost),
  control: () => opened(() => json(page([]))),
  succeeds: (said) => expect(said).toEqual([]),
});
