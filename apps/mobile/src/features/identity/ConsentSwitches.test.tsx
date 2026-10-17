import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { act, fireEvent, renderHook, screen, waitFor } from "@testing-library/react-native";
import type * as React from "react";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import { ConsentSwitch, useConsentStates } from "./ConsentSwitches";

// A withdrawable consent as a switch (#46, #146), each on its own screen in
// Settings since #287: shown as the API holds it, given for the bundled
// wording, withdrawn by a DELETE, a failure that leaves the switch as it was,
// and the list's states for the rows that open them.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const session = {
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token("access"),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: token("refresh"),
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fetchMock(handlers: Array<(req: Request) => Response | null>) {
  const calls: Request[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string) => {
    const req = input instanceof Request ? input : new Request(input);
    calls.push(req);
    for (const handler of handlers) {
      const res = handler(req);
      if (res) return res;
    }
    throw new Error(`unexpected ${req.method} ${req.url}`);
  }) as unknown as typeof fetch;
  return calls;
}
const show = async (ui: React.ReactElement) => {
  await act(async () => {
    renderWithTheme(ui);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  });
};

beforeEach(async () => {
  await saveSession(session);
});
afterEach(async () => {
  await clearSession();
});

describe("ConsentSwitch", () => {
  it("shows the research opt-in as a switch and withdraws it", async () => {
    const version = "2026-09-draft-1";
    const given: {
      kind: string;
      version: string;
      locale: string;
      givenAt: string;
      withdrawnAt: string | null;
    } = {
      kind: "research",
      version,
      locale: "en",
      givenAt: "2026-09-26T10:00:00.000Z",
      withdrawnAt: null,
    };
    const versions = {
      terms: version,
      privacy: version,
      research: version,
      special_category: "2026-10-draft-2",
    };
    let consents = [given];
    fetchMock([
      (req) => {
        const path = new URL(req.url).pathname;
        if (req.method === "GET" && path === "/consents") {
          return json({ consents, currentVersions: versions });
        }
        if (req.method === "DELETE" && path === "/consents/research") {
          consents = [{ ...given, withdrawnAt: "2026-09-26T11:00:00.000Z" }];
          return json({ consents, currentVersions: versions });
        }
        return null;
      },
    ]);
    await show(<ConsentSwitch kind="research" />);
    const toggle = await screen.findByLabelText("Take part in research");
    expect(toggle.props.accessibilityState?.checked).toBe(true);
    expect(screen.getByText(/You can change this at any time/)).toBeTruthy();
    // One switch, its own kind only (#287).
    expect(screen.queryByLabelText("Store my sensitive answers")).toBeNull();
    await fireEvent(toggle, "press");
    await waitFor(() =>
      expect(screen.getByLabelText("Take part in research").props.accessibilityState?.checked).toBe(
        false,
      ),
    );
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  });

  /** The consents as the API holds them, for the bundled wording; research given or not. */
  function consentsApi(options: { research: boolean; failGive?: boolean }) {
    const versions = {
      terms: CONSENT_VERSIONS.terms,
      privacy: CONSENT_VERSIONS.privacy,
      research: CONSENT_VERSIONS.research,
      special_category: CONSENT_VERSIONS.special_category,
    };
    const record = (kind: string) => ({
      kind,
      version: CONSENT_VERSIONS.research,
      locale: "en",
      givenAt: "2026-09-26T10:00:00.000Z",
      withdrawnAt: null,
    });
    let consents = options.research ? [record("research")] : [];
    return fetchMock([
      (req) => {
        const path = new URL(req.url).pathname;
        if (req.method === "GET" && path === "/consents") {
          return json({ consents, currentVersions: versions });
        }
        if (req.method === "POST" && path === "/consents") {
          if (options.failGive) {
            return json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500);
          }
          consents = [record("research")];
          return json({ consents, currentVersions: versions });
        }
        return null;
      },
    ]);
  }

  it("gives the research consent for the wording built into the app, in the app's language", async () => {
    const calls = consentsApi({ research: false });
    await show(<ConsentSwitch kind="research" />);
    const toggle = await screen.findByLabelText("Take part in research");
    expect(toggle.props.accessibilityState?.checked).toBe(false);
    await fireEvent(toggle, "press");
    await waitFor(() =>
      expect(screen.getByLabelText("Take part in research").props.accessibilityState?.checked).toBe(
        true,
      ),
    );
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(await (post as Request).text())).toEqual({
      kind: "research",
      version: CONSENT_VERSIONS.research,
      locale: "en",
    });
  });

  it("says so when the research choice could not be saved, and leaves the switch as it was", async () => {
    consentsApi({ research: false, failGive: true });
    await show(<ConsentSwitch kind="research" />);
    await fireEvent(await screen.findByLabelText("Take part in research"), "press");
    expect(
      await screen.findByText("The research choice could not be saved. Try again."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Take part in research").props.accessibilityState?.checked).toBe(
      false,
    );
  });

  /** Consents where the sensitive answers' wording is newer than this app's: that switch is locked. */
  function newerSensitiveWording() {
    const version = "2026-09-draft-1";
    const versions = {
      terms: version,
      privacy: version,
      research: CONSENT_VERSIONS.research,
      // Newer than the app's wording: the switch is locked until the app is updated.
      special_category: "2099-01-newer-than-this-app",
    };
    const given = {
      kind: "research",
      version: CONSENT_VERSIONS.research,
      locale: "en",
      givenAt: "2026-09-26T10:00:00.000Z",
      withdrawnAt: null as string | null,
    };
    let consents: Array<typeof given> = [];
    return fetchMock([
      (req) => {
        const path = new URL(req.url).pathname;
        if (req.method === "GET" && path === "/consents") {
          return json({ consents, currentVersions: versions });
        }
        if (req.method === "POST" && path === "/consents") {
          consents = [given];
          return json({ consents, currentVersions: versions });
        }
        return null;
      },
    ]);
  }

  it("says the sensitive answers' own words when their choice could not be saved (#287)", async () => {
    const versions = {
      terms: CONSENT_VERSIONS.terms,
      privacy: CONSENT_VERSIONS.privacy,
      research: CONSENT_VERSIONS.research,
      special_category: CONSENT_VERSIONS.special_category,
    };
    const given = {
      kind: "special_category",
      version: CONSENT_VERSIONS.special_category,
      locale: "en",
      givenAt: "2026-09-26T10:00:00.000Z",
      withdrawnAt: null,
    };
    fetchMock([
      (req) => {
        const path = new URL(req.url).pathname;
        if (req.method === "GET" && path === "/consents") {
          return json({ consents: [given], currentVersions: versions });
        }
        if (req.method === "DELETE" && path === "/consents/special_category") {
          return json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500);
        }
        return null;
      },
    ]);
    await show(<ConsentSwitch kind="special_category" />);
    const toggle = await screen.findByLabelText("Store my sensitive answers");
    expect(toggle.props.accessibilityState?.checked).toBe(true);
    await fireEvent(toggle, "press");
    expect(
      await screen.findByText("The sensitive-answers choice could not be saved. Try again."),
    ).toBeTruthy();
    expect(screen.queryByText("The research choice could not be saved. Try again.")).toBeNull();
    expect(
      screen.getByLabelText("Store my sensitive answers").props.accessibilityState?.checked,
    ).toBe(true);
  });

  it("toggles from its words too", async () => {
    newerSensitiveWording();
    await show(<ConsentSwitch kind="research" />);
    await screen.findByLabelText("Take part in research");
    await act(async () => {
      fireEvent.press(screen.getByText("Take part in research"));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Take part in research").props.accessibilityState?.checked).toBe(
        true,
      ),
    );
  });

  it("locks a switch whose wording is newer than this app's, says to update, and its words do nothing", async () => {
    const calls = newerSensitiveWording();
    await show(<ConsentSwitch kind="special_category" />);
    const toggle = await screen.findByLabelText("Store my sensitive answers");
    expect(toggle.props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByText(/Update the app/)).toBeTruthy();
    const before = calls.length;
    await act(async () => {
      fireEvent.press(screen.getByText("Store my sensitive answers"));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    expect(calls.length).toBe(before);
    expect(
      screen.getByLabelText("Store my sensitive answers").props.accessibilityState?.checked,
    ).toBe(false);
  });

  it("says it is reading the consent while the read is on its way", async () => {
    globalThis.fetch = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    await show(<ConsentSwitch kind="research" />);
    expect(screen.getByText("Reading your choice…")).toBeTruthy();
    expect(screen.queryByLabelText("Take part in research")).toBeNull();
  });

  it("says why the consent could not be read, and reads it again on request (#287)", async () => {
    let failing = true;
    const calls = fetchMock([
      () =>
        failing
          ? json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500)
          : null,
    ]);
    await show(<ConsentSwitch kind="research" />);
    expect(screen.getByText("Your choice could not be read.")).toBeTruthy();
    expect(screen.getByText("Kuutti's server had a problem. Try again in a moment.")).toBeTruthy();
    failing = false;
    consentsApi({ research: true });
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Try again" }));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
    expect(
      (await screen.findByLabelText("Take part in research")).props.accessibilityState?.checked,
    ).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("shows nothing for a signed-out device", async () => {
    await clearSession();
    fetchMock([]);
    await show(<ConsentSwitch kind="research" />);
    expect(screen.queryByLabelText("Take part in research")).toBeNull();
    expect(screen.queryByText("Reading your choice…")).toBeNull();
  });
});

describe("useConsentStates", () => {
  const states = async () => {
    const view = await renderHook(() => useConsentStates(), {
      wrapper: ({ children }) => underProviders(children as React.ReactElement),
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
    return view.result;
  };

  it("says each consent's state for its row: on, off, or outdated for a wording newer than the app's", async () => {
    newerStatesApi();
    const result = await states();
    expect(result.current).toEqual({ research: "on", special_category: "outdated" });
  });

  it("is unavailable for both when the read fails", async () => {
    fetchMock([
      () => json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
    ]);
    expect((await states()).current).toEqual({
      research: "unavailable",
      special_category: "unavailable",
    });
  });

  it("is loading without a session, and reads nothing", async () => {
    await clearSession();
    const calls = fetchMock([]);
    expect((await states()).current).toEqual({ research: "loading", special_category: "loading" });
    expect(calls).toHaveLength(0);
  });

  function newerStatesApi() {
    const versions = {
      terms: CONSENT_VERSIONS.terms,
      privacy: CONSENT_VERSIONS.privacy,
      research: CONSENT_VERSIONS.research,
      special_category: "2099-01-newer-than-this-app",
    };
    const research = {
      kind: "research",
      version: CONSENT_VERSIONS.research,
      locale: "en",
      givenAt: "2026-09-26T10:00:00.000Z",
      withdrawnAt: null,
    };
    fetchMock([
      (req) =>
        req.method === "GET" && new URL(req.url).pathname === "/consents"
          ? json({ consents: [research], currentVersions: versions })
          : null,
    ]);
  }
});
