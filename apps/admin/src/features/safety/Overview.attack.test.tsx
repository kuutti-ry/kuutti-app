import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setRoleAnswerHandler, setTokenSource } from "../../lib/api.ts";
import { attack } from "../../test/attack.ts";
import { held, json, network, on, sentTo, settled } from "../../test/network.ts";
import { Overview } from "./Overview.tsx";

// What goes through today (#380): a question, where no line says what should happen.
const QUESTION = "#380, a question";

// Attacks on the front page's one read (#380, #303): GET /admin/overview, on
// opening and on Refresh. Each tries what the read must not do and stays
// green while that fails; its control does the same thing rightly.

const NOW = "2031-03-09T12:00:00.000Z";
const HOUR = 3_600_000;
/** An instant `ms` from the API's now. */
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
const none = { here: 0, elsewhere: 0, other: 0 };
/** The answer: one queue, the photos, `waiting` of them, the oldest stamped at `oldest`. */
const overview = (waiting: number, oldest = at(-2 * HOUR)) => ({
  now: NOW,
  responseHours: 24,
  reviewHours: 48,
  queues: [{ queue: "photos", waiting, oldestSince: oldest }],
  foundThem: { days: 30, recent: none, allTime: none },
});
const failure = (status: number, code: string) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const OVERVIEW = "/admin/overview";

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
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Overview />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

/** The photos' line as the page shows it; null when it shows none. */
const photosLine = () =>
  screen.queryByRole("link", { name: "Photos" })?.closest("li")?.textContent ?? null;
const refresh = () => fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
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
 * Opens the page, then presses Refresh twice, both answers held; gives the
 * one named first "5 wait" and the other, last, "9 wait". The page should
 * show what the newer request answered, whichever arrives last.
 */
async function refreshedTwice(first: "older" | "newer") {
  const older = held();
  const newer = held();
  const sent = network([
    on(
      "GET",
      OVERVIEW,
      inTurn(
        () => json(overview(1)),
        () => older.promise,
        () => newer.promise,
      ),
    ),
  ]);
  show();
  await screen.findByText(/1 waits/);
  refresh();
  refresh();
  await settled();
  if (sentTo(sent, "GET", OVERVIEW).length !== 3) throw new Error("both refreshes not sent");
  const [early, late] = first === "older" ? [older, newer] : [newer, older];
  early.answer(json(overview(5)));
  await drain();
  late.answer(json(overview(9)));
  await drain();
  return photosLine();
}

attack(
  "Overview: the first refresh's answer, arriving after the second's, is what the page shows",
  {
    // An older refresh's answer still lands after a newer one's: the overview keeps no order of its reads, and is no list that useList holds.
    open: QUESTION,
    attempt: () => refreshedTwice("newer"),
    control: () => refreshedTwice("older"),
    succeeds: (line) => expect(line).toMatch(/9 wait/),
  },
);

/** Opens the page on one line, then presses Refresh once, answered as given. */
async function refreshedInto(second: Reply) {
  network([
    on(
      "GET",
      OVERVIEW,
      inTurn(() => json(overview(1)), second),
    ),
  ]);
  show();
  await screen.findByText(/1 waits/);
  refresh();
  await drain();
  return alerts();
}

attack("Overview: a refresh that fails after a good load says nothing of it", {
  attempt: () => refreshedInto(() => failure(500, "internal_error")),
  control: () => refreshedInto(() => json(overview(2))),
  succeeds: (said) => expect(said).toEqual([]),
});

attack("Overview: a refresh refused with 403 is said as the page's own failure", {
  attempt: () => refreshedInto(() => failure(403, "admin_forbidden")),
  control: () => refreshedInto(() => failure(500, "internal_error")),
  succeeds: (said) => expect(said).toContain("Could not be loaded."),
});

/** The first load never answers; then Refresh, answered as given. */
async function stuckThenRefreshed(second: Reply) {
  const never = held();
  const sent = network([
    on(
      "GET",
      OVERVIEW,
      inTurn(() => never.promise, second),
    ),
  ]);
  show();
  await settled();
  if (sentTo(sent, "GET", OVERVIEW).length !== 1) throw new Error("the first load not sent");
  refresh();
  await drain();
  return photosLine();
}

attack("Overview: a load that never answers keeps the page from showing what waits for good", {
  attempt: () => stuckThenRefreshed(() => json(overview(3))),
  // The second never answers either: nothing to show, rightly.
  control: () => stuckThenRefreshed(() => held().promise),
  succeeds: (line) => expect(line).toBeNull(),
});

/** Opens the page on a photos' line whose oldest is stamped at `oldest`. */
async function oldestAt(oldest: string) {
  network([on("GET", OVERVIEW, () => json(overview(1, oldest)))]);
  show();
  await screen.findByRole("link", { name: "Photos" });
  await settled();
  return photosLine();
}

// The API reads its clock before it reads the queues: a photo appealed in
// between is stamped after `now`. Nothing in the contract orders the two.
attack(
  "Overview: an oldest stamped a millisecond after the API's now reads as another age than less than an hour",
  {
    attempt: () => oldestAt(at(1)),
    control: () => oldestAt(at(-2 * HOUR)),
    succeeds: (line) => expect(line).not.toMatch(/Oldest: less than an hour$/),
  },
);
