import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import type * as React from "react";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { ConsentSwitches } from "./ConsentSwitches";

// The two withdrawable consents as switches (#46, #146), under "App settings"
// since #170: shown as the API holds them, given for the bundled wording,
// withdrawn by a DELETE, and a failure that leaves the switch as it was.

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

describe("ConsentSwitches", () => {
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
    await show(<ConsentSwitches />);
    const toggle = await screen.findByLabelText("Take part in research");
    expect(toggle.props.accessibilityState?.checked).toBe(true);
    expect(screen.getByText(/You can change this at any time/)).toBeTruthy();
    await fireEvent(toggle, "press");
    await waitFor(() =>
      expect(screen.getByLabelText("Take part in research").props.accessibilityState?.checked).toBe(
        false,
      ),
    );
    // The special-category consent has its own switch, off here, and withdrawing it is a DELETE of its kind (#146).
    expect(
      screen.getByLabelText("Store my sensitive answers").props.accessibilityState?.checked,
    ).toBe(false);
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
    await show(<ConsentSwitches />);
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
    await show(<ConsentSwitches />);
    await fireEvent(await screen.findByLabelText("Take part in research"), "press");
    expect(
      await screen.findByText("The research choice could not be saved. Try again."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Take part in research").props.accessibilityState?.checked).toBe(
      false,
    );
  });

  it("toggles from the words too, and a switch locked by an outdated wording ignores them", async () => {
    const version = "2026-09-draft-1";
    const versions = {
      terms: version,
      privacy: version,
      research: CONSENT_VERSIONS.research,
      // Newer than the app's wording: the switch is locked until the app is updated.
      special_category: "2099-01-newer-than-this-app",
    };
    let consents: Array<{
      kind: string;
      version: string;
      locale: string;
      givenAt: string;
      withdrawnAt: string | null;
    }> = [];
    const calls = fetchMock([
      (req) => {
        const path = new URL(req.url).pathname;
        if (req.method === "GET" && path === "/consents") {
          return json({ consents, currentVersions: versions });
        }
        if (req.method === "POST" && path === "/consents") {
          consents = [
            {
              kind: "research",
              version: CONSENT_VERSIONS.research,
              locale: "en",
              givenAt: "2026-09-26T10:00:00.000Z",
              withdrawnAt: null,
            },
          ];
          return json({ consents, currentVersions: versions });
        }
        return null;
      },
    ]);
    await show(<ConsentSwitches />);
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
    // The sensitive-answers switch is locked (the app's wording is older): its words do nothing.
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

  it("shows nothing for a signed-out device", async () => {
    await clearSession();
    fetchMock([]);
    await show(<ConsentSwitches />);
    expect(screen.queryByLabelText("Take part in research")).toBeNull();
  });
});
