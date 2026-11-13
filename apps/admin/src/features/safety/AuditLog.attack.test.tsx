import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource } from "../../lib/api.ts";
import { attack } from "../../test/attack.ts";
import { held, json, network, on, settled } from "../../test/network.ts";
import { AuditLog } from "./AuditLog.tsx";

// Attacks on the audit log's reader (#380, #309): its pages, narrowed by the
// filters, tried the wrong way beside a control that does the same thing
// rightly.

const ACTOR = "3c9d0f5e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const ACCOUNT = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const AUDIT = "/admin/audit";
const row = {
  at: "2026-10-15T12:00:00.000Z",
  actorIdentityId: ACTOR,
  actorRole: "moderator",
  action: "account.view",
  subjectType: "account",
  subjectId: ACCOUNT,
  accountId: ACCOUNT,
  detail: null,
};
const failure = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

const filters = () => within(screen.getByRole("form", { name: "Filters" }));
function search(who: string) {
  fireEvent.change(filters().getByLabelText("Who"), { target: { value: who } });
  fireEvent.click(filters().getByRole("button", { name: "Show" }));
}

async function settle() {
  for (let turn = 0; turn < 3; turn++) await settled();
}

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter>
        <AuditLog />
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Two searches out at once; the one the API refuses (400) is answered last, as the older search or the newer. */
async function refusedLast(refused: "older" | "newer") {
  const refusal = held();
  const page = held();
  network([
    on("GET", AUDIT, (request) => {
      const who = new URL(request.url).searchParams.get("actor");
      if (who === null) return json({ items: [], next: null });
      return who === "someone" ? refusal.promise : page.promise;
    }),
  ]);
  show();
  await screen.findByText("Nothing matches.");
  for (const who of refused === "older" ? ["someone", ACTOR] : [ACTOR, "someone"]) search(who);
  await settle();
  page.answer(json({ items: [row], next: null }));
  await settle();
  refusal.answer(failure("validation_failed", 400));
  await settle();
  return screen.queryByText(/^A filter is not valid/) !== null;
}

attack(
  "AuditLog: a search the API refused, answered after a later search, says a filter is not valid over the later one",
  {
    attempt: () => refusedLast("older"),
    control: () => refusedLast("newer"),
    succeeds: (said) => expect(said).toBe(true),
  },
);
