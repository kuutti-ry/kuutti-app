import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { attack } from "../../test/attack.ts";
import { held, json, network, on, sentTo, settled } from "../../test/network.ts";
import { restoreReturnPath } from "./return-path.ts";
import { SignIn } from "./SignIn.tsx";
import { StaffSessionProvider, useStaffSession } from "./session.tsx";

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
 * These attacks inject network rejections. A regression in the session
 * catch may leave one unhandled; only the exact error the attempt
 * injects may go unhandled, at most once. Zero is allowed: a future fix can
 * catch it, and the attack then judges what the panel showed. Every other
 * rejection still fails the test, even if the screen stays as it was.
 */
async function countingUnhandled<T>(expected: Error | undefined, run: () => Promise<T>) {
  let unhandled = 0;
  const unexpected: unknown[] = [];
  const theirs = process.listeners("unhandledRejection");
  const count = (reason: unknown) => {
    if (expected !== undefined && reason === expected) unhandled += 1;
    else unexpected.push(reason);
  };
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", count);
  try {
    const seen = await run();
    if (unexpected.length > 0) {
      throw new AggregateError(unexpected, "unexpected unhandled rejection in the attack");
    }
    if (unhandled > 1) throw new Error("the injected rejection went unhandled more than once");
    return { ...seen, unhandled };
  } finally {
    process.off("unhandledRejection", count);
    for (const listener of theirs) process.on("unhandledRejection", listener);
  }
}

describe("the session attack's expected rejection", () => {
  it("counts only the exact injected error, and restores the runner's listeners", async () => {
    const expected = new TypeError("Failed to fetch");
    const listeners = process.listeners("unhandledRejection");
    const seen = await countingUnhandled(expected, async () => {
      process.emit("unhandledRejection", expected, Promise.resolve());
      return { said: false };
    });
    expect(seen).toEqual({ said: false, unhandled: 1 });
    expect(process.listeners("unhandledRejection")).toEqual(listeners);
  });

  it("allows the injected error to be caught by a repaired session", async () => {
    expect(await countingUnhandled(new TypeError("Failed to fetch"), async () => ({}))).toEqual({
      unhandled: 0,
    });
  });

  it("leaves a control with no rejection at zero", async () => {
    expect(await countingUnhandled(undefined, async () => ({}))).toEqual({ unhandled: 0 });
  });

  it.each([undefined, new TypeError("Failed to fetch")])(
    "fails an unexpected rejection, even one with the injected error's message (%s)",
    async (expected) => {
      const unexpected = new TypeError("Failed to fetch");
      const listeners = process.listeners("unhandledRejection");
      await expect(
        countingUnhandled(expected, async () => {
          process.emit("unhandledRejection", unexpected, Promise.resolve());
          return { said: false };
        }),
      ).rejects.toMatchObject({ errors: [unexpected] });
      expect(process.listeners("unhandledRejection")).toEqual(listeners);
    },
  );

  it("fails when the same injected error escapes twice", async () => {
    const expected = new TypeError("Failed to fetch");
    await expect(
      countingUnhandled(expected, async () => {
        process.emit("unhandledRejection", expected, Promise.resolve());
        process.emit("unhandledRejection", expected, Promise.resolve());
        return {};
      }),
    ).rejects.toThrow("more than once");
  });

  it("restores the runner's listeners when the attempt itself throws", async () => {
    const failure = new Error("broken setup");
    const listeners = process.listeners("unhandledRejection");
    await expect(
      countingUnhandled(undefined, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(process.listeners("unhandledRejection")).toEqual(listeners);
  });
});

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
  const lost = new TypeError("Failed to fetch");
  const exchange = held();
  const sent = network([on("POST", EXCHANGE, () => exchange.promise)]);
  return countingUnhandled(failsOutright ? lost : undefined, async () => {
    window.history.replaceState(null, "", `/${CODE}`);
    show();
    await settle();
    expect(sentTo(sent, "POST", EXCHANGE)).toHaveLength(1);
    if (failsOutright) exchange.fail(lost);
    await settle();
    return {
      state: screen.getByTestId("state").textContent,
      said: screen.queryByText(GENERIC) !== null,
    };
  });
}

// admin.signIn.error.generic: any other sign-in failure, "a used code, the API unreachable".
attack(
  "session: an exchange that fails outright leaves the sign-in loading without saying it did not complete",
  {
    attempt: () => exchangeUnanswered(true),
    control: () => exchangeUnanswered(false),
    succeeds: (seen) => expect(seen.said).toBe(false),
  },
);

/** A stored session, its check with the API answered or failing outright. */
async function checkUnanswered(failsOutright: boolean) {
  window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(stored));
  const lost = new TypeError("Failed to fetch");
  const check = held();
  const sent = network([on("GET", WHOAMI, () => check.promise)]);
  return countingUnhandled(failsOutright ? lost : undefined, async () => {
    show();
    await settle();
    expect(sentTo(sent, "GET", WHOAMI)).toHaveLength(1);
    if (failsOutright) check.fail(lost);
    else check.answer(json({ role: "admin", expiresAt: stored.expiresAt }));
    await settle();
    return { state: screen.getByTestId("state").textContent };
  });
}

// session.tsx: "A stored token is checked against the API before anything is shown with it."
attack("session: a stored session whose check fails outright stays signed in, never checked", {
  attempt: () => checkUnanswered(true),
  control: () => checkUnanswered(false),
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
      attempt: () => restored(path),
      control: () => restored(legitimate),
      succeeds: (hosts) => expect(hosts).toHaveLength(1),
    },
  );
}
