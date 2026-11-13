import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { attack } from "../../test/attack.ts";
import { held, json, network, on, settled } from "../../test/network.ts";
import { restoreReturnPath } from "./return-path.ts";
import { SignIn } from "./SignIn.tsx";
import { StaffSessionProvider, useStaffSession } from "./session.tsx";

// What goes through today (#380): a hole, which its contract forbids.
const HOLE = "#380";

// Attacks on the staff session (#380, #49, #250, #302): the way back from the
// bank, the exchange of the one-time code, the check of a stored session,
// tried the wrong way beside a control that does the same thing rightly.

const EXCHANGE = "/admin/auth/exchange";
const WHOAMI = "/admin/whoami";
const CODE = `#code=${"c".repeat(43)}`;
const stored = {
  accessToken: "a".repeat(43),
  expiresAt: "2030-01-01T08:00:00.000Z",
  role: "admin",
};
const failure = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const GENERIC = "Sign-in did not complete. Try again.";

function Probe() {
  const state = useStaffSession();
  return (
    <p data-testid="state">
      {state.status}
      {state.status === "signed-in" ? ` ${state.session.role}` : ""}
    </p>
  );
}

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <StaffSessionProvider>
        <Probe />
        <MemoryRouter>
          <SignIn />
        </MemoryRouter>
      </StaffSessionProvider>
    </I18nProvider>,
  );
}

async function settle() {
  for (let turn = 0; turn < 3; turn++) await settled();
}

/**
 * The session's own requests are not caught where they are made, so a fetch
 * that fails outright rejects a promise nobody holds, and Vitest fails the
 * whole run on an unhandled rejection. While an attempt runs such rejections
 * are counted here instead, and Vitest's own listeners are put back after:
 * the attack is judged by what the panel did.
 */
async function countingUnhandled<T>(run: () => Promise<T>) {
  const unhandled: unknown[] = [];
  const theirs = process.listeners("unhandledRejection");
  const count = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", count);
  try {
    return { ...(await run()), unhandled: unhandled.length };
  } finally {
    process.off("unhandledRejection", count);
    for (const listener of theirs) process.on("unhandledRejection", listener);
  }
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The code back from the bank, its exchange not answered yet or failing outright. */
async function exchangeUnanswered(failsOutright: boolean) {
  const exchange = held();
  network([on("POST", EXCHANGE, () => exchange.promise)]);
  window.history.replaceState(null, "", `/${CODE}`);
  show();
  await settle();
  if (failsOutright) exchange.fail();
  await settle();
  return {
    state: screen.getByTestId("state").textContent,
    said: screen.queryByText(GENERIC) !== null,
  };
}

// admin.signIn.error.generic: any other sign-in failure, "a used code, the API unreachable".
attack(
  "session: an exchange that fails outright leaves the sign-in loading without saying it did not complete",
  {
    // Goes through today: the exchange has no catch for a request that fails outright.
    open: HOLE,
    attempt: () => countingUnhandled(() => exchangeUnanswered(true)),
    control: () => countingUnhandled(() => exchangeUnanswered(false)),
    succeeds: (seen) => expect(seen.said).toBe(false),
  },
);

/** A stored session, its check with the API answered or failing outright. */
async function checkUnanswered(failsOutright: boolean) {
  window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(stored));
  const check = held();
  network([on("GET", WHOAMI, () => check.promise)]);
  show();
  await settle();
  if (failsOutright) check.fail();
  else check.answer(json({ role: "admin", expiresAt: stored.expiresAt }));
  await settle();
  return { state: screen.getByTestId("state").textContent };
}

// session.tsx: "A stored token is checked against the API before anything is shown with it."
attack("session: a stored session whose check fails outright stays signed in, never checked", {
  // Goes through today: the check of a stored session has no catch for a request that fails outright.
  open: HOLE,
  attempt: () => countingUnhandled(() => checkUnanswered(true)),
  control: () => countingUnhandled(() => checkUnanswered(false)),
  succeeds: (seen) => expect(seen.state).toBe("signed-in admin"),
});

async function exchangeRefused(code: string, status: number) {
  network([on("POST", EXCHANGE, () => failure(code, status))]);
  window.history.replaceState(null, "", `/${CODE}`);
  show();
  await settle();
  return screen.queryByRole("alert")?.textContent ?? null;
}

const refusals = [
  ["a used code (401 auth_code_used)", "auth_code_used", 401],
  ["a code it does not take (400 validation_failed)", "validation_failed", 400],
] as const;
for (const [what, code, status] of refusals) {
  attack(
    `session: an exchange refused as ${what} says something other than that sign-in did not complete`,
    {
      attempt: () => exchangeRefused(code, status),
      control: () => exchangeRefused("admin_not_allowed", 403),
      succeeds: (said) => expect(said).not.toBe(GENERIC),
    },
  );
}

// return-path.ts: "one that is not a path of this origin is dropped"; never another host.
const smuggled = [
  ["a tab", "/\t/evil.example/photos", "/t/evil.example/photos"],
  ["a line feed", "/\n/evil.example/photos", "/n/evil.example/photos"],
  ["a carriage return", "/\r/evil.example/photos", "/r/evil.example/photos"],
] as const;
for (const [what, path, legitimate] of smuggled) {
  const restored = (remembered: string) => {
    window.sessionStorage.setItem("kuutti.admin.return", remembered);
    const history = { replaceState: vi.fn() };
    restoreReturnPath({ hash: CODE }, history);
    // Where each address put back leads, read as the browser reads it.
    return history.replaceState.mock.calls.map(
      ([, , url]) => new URL(String(url), "https://admin.kuutti.app").host,
    );
  };
  attack(
    `return path: a remembered path with ${what} after its slash, which leads to another host, is put back`,
    {
      // Goes through today, for all three: the guard reads the path before the browser drops tabs and line breaks from it.
      open: HOLE,
      attempt: () => restored(path),
      control: () => restored(legitimate),
      succeeds: (hosts) => expect(hosts).toHaveLength(1),
    },
  );
}
