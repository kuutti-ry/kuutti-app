import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource } from "../../lib/api.ts";
import { attack } from "../../test/attack.ts";
import { type Held, held, json, network, on, sentTo, settled } from "../../test/network.ts";
import { StaffList } from "./StaffList.tsx";

// Attacks on the staff list (#380, #310): who holds a role, read to check the
// access policy against what is true, tried the wrong way beside a control
// that does the same thing rightly.

const ADMIN = "3c9d0f5e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const MODERATOR = "7a2d2d5f-0b9f-4b1c-8d4b-1d9e2f3a4b5c";
const STAFF = "/admin/staff";
const member = (identityId: string, role: string) => ({
  identityId,
  role,
  grantedAt: "2026-09-25T10:00:00.000Z",
  grantedBy: "maintainer",
  lastSignInAt: null,
});
const both = () => json({ items: [member(ADMIN, "admin"), member(MODERATOR, "moderator")] });
const adminOnly = () => json({ items: [member(ADMIN, "admin")] });

async function settle() {
  for (let turn = 0; turn < 3; turn++) await settled();
}

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter>
        <StaffList />
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

/** Two refreshes out at once; the answer given last still lists the moderator, from the older request or the newer. */
async function refreshedTwice(order: "reverse" | "in order") {
  const first = held();
  const second = held();
  const later = [first, second];
  let loads = 0;
  const sent = network([
    on("GET", STAFF, () => (loads++ === 0 ? both() : (later.shift() as Held).promise)),
  ]);
  show();
  await screen.findByText(MODERATOR);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await settle();
  expect(sentTo(sent, "GET", STAFF)).toHaveLength(3);
  const [early, late] = order === "reverse" ? [second, first] : [first, second];
  // The moderator's role was revoked: the newer of the two reads no longer lists it.
  early.answer(adminOnly());
  await settle();
  late.answer(both());
  await settle();
  return screen.queryByText(MODERATOR) !== null;
}

attack("StaffList: the older of two refreshes, answered last, lists a role that was revoked", {
  attempt: () => refreshedTwice("reverse"),
  control: () => refreshedTwice("in order"),
  succeeds: (listed) => expect(listed).toBe(true),
});

async function refreshedAfterAGoodLoad(failsOutright: boolean) {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const again = held();
  let loads = 0;
  network([on("GET", STAFF, () => (loads++ === 0 ? both() : again.promise))]);
  show();
  await screen.findByText(MODERATOR);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await settle();
  if (failsOutright) again.fail();
  else again.answer(both());
  await settle();
  return screen.queryByRole("alert") !== null;
}

attack("StaffList: a refresh that cannot reach the API after a good load says nothing", {
  attempt: () => refreshedAfterAGoodLoad(true),
  control: () => refreshedAfterAGoodLoad(false),
  succeeds: (said) => expect(said).toBe(false),
});
