import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { act, fireEvent, renderHook, screen, waitFor } from "@testing-library/react-native";
import type * as React from "react";
import { Linking } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import { ConsentSwitch, useConsentStates } from "./ConsentSwitches";

// A withdrawable consent as a switch (#46, #146), under its own row in Settings
// since #287 and #511: shown as the API holds it, given for the bundled wording,
// withdrawn by a DELETE, a failure that leaves the switch as it was, and the
// list's states for the rows that open them. The sensitive answers are the one
// kind switched here: research is not asked (#545, ADR-010 §19).

const LABEL = "Store my sensitive answers";
const FAILED = "The sensitive-answers choice could not be saved. Try again.";
const SENSITIVE = String(CONSENT_VERSIONS.special_category);

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const session = {
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token("access"),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: `${token("family")}.${token("refresh")}`,
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const serverError = () =>
  json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500);

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

/** The API's versions, the ones this app carries; `sensitive` overrides the consent's own. */
const versions = (sensitive = SENSITIVE) => ({
  terms: CONSENT_VERSIONS.terms,
  privacy: CONSENT_VERSIONS.privacy,
  research: CONSENT_VERSIONS.research,
  special_category: sensitive,
});
const record = (kind = "special_category", version = SENSITIVE) => ({
  kind,
  version,
  locale: "en",
  givenAt: "2026-09-26T10:00:00.000Z",
  withdrawnAt: null as string | null,
});

/** The consents as the API holds them; the sensitive answers given or not. */
function consentsApi(options: {
  given: boolean;
  failGive?: boolean;
  failWithdraw?: boolean;
  sensitive?: string;
}) {
  let consents = options.given ? [record()] : [];
  const answer = () => json({ consents, currentVersions: versions(options.sensitive) });
  return fetchMock([
    (req) => {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/consents") return answer();
      if (req.method === "POST" && path === "/consents") {
        if (options.failGive) return serverError();
        consents = [record()];
        return answer();
      }
      if (req.method === "DELETE" && path === "/consents/special_category") {
        if (options.failWithdraw) return serverError();
        consents = [{ ...record(), withdrawnAt: "2026-09-26T11:00:00.000Z" }];
        return answer();
      }
      return null;
    },
  ]);
}

beforeEach(async () => {
  await saveSession(session);
});
afterEach(async () => {
  await clearSession();
});

describe("ConsentSwitch", () => {
  it("shows the consent as a switch and withdraws it", async () => {
    consentsApi({ given: true });
    await show(<ConsentSwitch kind="special_category" />);
    const toggle = await screen.findByLabelText(LABEL);
    expect(toggle.props.accessibilityState?.checked).toBe(true);
    expect(screen.getByText(/Switching this off removes those answers/)).toBeTruthy();
    await fireEvent(toggle, "press");
    await waitFor(() =>
      expect(screen.getByLabelText(LABEL).props.accessibilityState?.checked).toBe(false),
    );
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  });

  it("gives the consent for the wording built into the app, in the app's language", async () => {
    const calls = consentsApi({ given: false });
    await show(<ConsentSwitch kind="special_category" />);
    const toggle = await screen.findByLabelText(LABEL);
    expect(toggle.props.accessibilityState?.checked).toBe(false);
    await fireEvent(toggle, "press");
    await waitFor(() =>
      expect(screen.getByLabelText(LABEL).props.accessibilityState?.checked).toBe(true),
    );
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(await (post as Request).text())).toEqual({
      kind: "special_category",
      version: SENSITIVE,
      locale: "en",
    });
  });

  it("hands what a change stored to the row above it, and nothing when the change fails (#511)", async () => {
    consentsApi({ given: false });
    const stored = jest.fn();
    await show(<ConsentSwitch kind="special_category" onStored={stored} />);
    await fireEvent(await screen.findByLabelText(LABEL), "press");
    await waitFor(() => expect(stored).toHaveBeenCalledTimes(1));
    expect(stored.mock.calls[0]?.[0].consents).toEqual([
      expect.objectContaining({ kind: "special_category", withdrawnAt: null }),
    ]);
    stored.mockClear();
    consentsApi({ given: false, failGive: true });
    await show(<ConsentSwitch kind="special_category" onStored={stored} />);
    await fireEvent(await screen.findByLabelText(LABEL), "press");
    expect(await screen.findByText(FAILED)).toBeTruthy();
    expect(stored).not.toHaveBeenCalled();
  });

  it("links to its full text at the version a yes here is given to (#208)", async () => {
    consentsApi({ given: false });
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await show(<ConsentSwitch kind="special_category" />);
    await screen.findByLabelText(LABEL);
    await fireEvent.press(
      screen.getByRole("link", {
        name: `Read the full text on kuutti.app (version ${SENSITIVE})`,
      }),
    );
    expect(open).toHaveBeenCalledWith(
      `https://kuutti.app/legal/privacy/#special_category-${SENSITIVE}`,
    );
    open.mockRestore();
  });

  it.each([
    ["given", { given: false, failGive: true }, false],
    ["withdrawn", { given: true, failWithdraw: true }, true],
  ])(
    "says so when the consent could not be %s, and leaves the switch as it was",
    async (_how, api, checked) => {
      consentsApi(api);
      await show(<ConsentSwitch kind="special_category" />);
      const toggle = await screen.findByLabelText(LABEL);
      expect(toggle.props.accessibilityState?.checked).toBe(checked);
      await fireEvent(toggle, "press");
      expect(await screen.findByText(FAILED)).toBeTruthy();
      expect(screen.getByLabelText(LABEL).props.accessibilityState?.checked).toBe(checked);
    },
  );

  it("toggles from its words too", async () => {
    consentsApi({ given: false });
    await show(<ConsentSwitch kind="special_category" />);
    await screen.findByLabelText(LABEL);
    await act(async () => {
      fireEvent.press(screen.getByText(LABEL));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    await waitFor(() =>
      expect(screen.getByLabelText(LABEL).props.accessibilityState?.checked).toBe(true),
    );
  });

  it("locks a switch whose wording is newer than this app's, says to update, and its words do nothing", async () => {
    const calls = consentsApi({ given: false, sensitive: "2099-01-newer-than-this-app" });
    await show(<ConsentSwitch kind="special_category" />);
    const toggle = await screen.findByLabelText(LABEL);
    expect(toggle.props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByText(/Update the app/)).toBeTruthy();
    const before = calls.length;
    await act(async () => {
      fireEvent.press(screen.getByText(LABEL));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    expect(calls.length).toBe(before);
    expect(screen.getByLabelText(LABEL).props.accessibilityState?.checked).toBe(false);
  });

  it("says it is reading the consent while the read is on its way", async () => {
    globalThis.fetch = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    await show(<ConsentSwitch kind="special_category" />);
    expect(screen.getByText("Reading your choice…")).toBeTruthy();
    expect(screen.queryByLabelText(LABEL)).toBeNull();
  });

  it("says why the consent could not be read, and reads it again on request (#287)", async () => {
    const calls = fetchMock([serverError]);
    await show(<ConsentSwitch kind="special_category" />);
    expect(screen.getByText("Your choice could not be read.")).toBeTruthy();
    expect(screen.getByText("Kuutti's server had a problem. Try again in a moment.")).toBeTruthy();
    consentsApi({ given: true });
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Try again" }));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
    expect((await screen.findByLabelText(LABEL)).props.accessibilityState?.checked).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("shows nothing for a signed-out device", async () => {
    await clearSession();
    fetchMock([]);
    await show(<ConsentSwitch kind="special_category" />);
    expect(screen.queryByLabelText(LABEL)).toBeNull();
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
  /** The read of GET /consents, as the API holds these rows of these versions. */
  const reading = (consents: unknown[], sensitive = SENSITIVE) =>
    fetchMock([
      (req) =>
        req.method === "GET" && new URL(req.url).pathname === "/consents"
          ? json({ consents, currentVersions: versions(sensitive) })
          : null,
    ]);

  it.each([
    ["on when given for the current wording", [record()], SENSITIVE, "on"],
    ["off when none is given", [], SENSITIVE, "off"],
    [
      "off when it was withdrawn",
      [{ ...record(), withdrawnAt: "2026-09-27T10:00:00.000Z" }],
      SENSITIVE,
      "off",
    ],
    ["off for an older wording", [record("special_category", "2025-01-draft-1")], SENSITIVE, "off"],
    [
      "off for a research consent, which is not this one",
      [record("research", SENSITIVE)],
      SENSITIVE,
      "off",
    ],
    [
      "outdated for a wording newer than the app's",
      [record()],
      "2099-01-newer-than-this-app",
      "outdated",
    ],
  ])("says the consent's state for its row: %s", async (_what, consents, sensitive, state) => {
    reading(consents, sensitive);
    expect((await states()).current.states).toEqual({ special_category: state });
  });

  it("is unavailable when the read fails", async () => {
    fetchMock([serverError]);
    expect((await states()).current.states).toEqual({ special_category: "unavailable" });
  });

  it("takes what a switch stored, so its row says it at once (#511)", async () => {
    reading([], "2099-01-newer-than-this-app");
    const result = await states();
    expect(result.current.states).toEqual({ special_category: "outdated" });
    await act(async () => {
      result.current.stored({
        consents: [],
        currentVersions: {
          terms: CONSENT_VERSIONS.terms ?? "",
          privacy: CONSENT_VERSIONS.privacy ?? "",
          research: CONSENT_VERSIONS.research ?? "",
          special_category: SENSITIVE,
        },
      });
    });
    expect(result.current.states).toEqual({ special_category: "off" });
  });

  it("is loading without a session, and reads nothing", async () => {
    await clearSession();
    const calls = fetchMock([]);
    expect((await states()).current.states).toEqual({ special_category: "loading" });
    expect(calls).toHaveLength(0);
  });
});
