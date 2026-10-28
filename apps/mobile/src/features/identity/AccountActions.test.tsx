import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { Directory } from "expo-file-system";
import type * as React from "react";
import { Platform, Share } from "react-native";
import { clearSession, currentSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { AccountActions, shareExport } from "./AccountActions";

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock };
};
const { __files: cache } = jest.requireMock("expo-file-system") as {
  __files: Map<string, Uint8Array>;
};
const pickDirectory = Directory.pickDirectoryAsync as jest.Mock;

// The account card (#51): export handed to the share sheet, deletion only
// after the confirmation, the device signed out when the API says 204.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const session = {
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token("access"),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: `${token("family")}.${token("refresh")}`,
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
};
// The API answers a zip (#237); what is inside is held by the API's tests.
const ZIP = new Uint8Array([
  0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const ZIP_NAME = "kuutti-data-2026-10-13.zip";
const zip = () =>
  new Response(ZIP, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${ZIP_NAME}"`,
    },
  });
const bytesOf = (file: Uint8Array | undefined) => (file ? Array.from(file) : undefined);

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
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
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

describe("AccountActions", () => {
  it("shows the four labelled buttons and nothing pressable is unlabelled or too small", async () => {
    fetchMock([]);
    await show(<AccountActions />);
    expect(
      await screen.findByText(
        "A file with everything Kuutti holds about you, and nothing about anyone else.",
      ),
    ).toBeTruthy();
    // Its screen carries the title (#287): the card does not repeat it.
    expect(screen.queryByText("Your account")).toBeNull();
    const found = pressables(screen.toJSON() as HostNode);
    expect(found).toHaveLength(4);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    // The consents are the app's settings now, not the account's (#170).
    expect(screen.queryByLabelText("Take part in research")).toBeNull();
  });

  it("opens the found-them screen from its button, and nothing happens before that (#83)", async () => {
    const requests = fetchMock([]);
    router.push.mockReset();
    await show(<AccountActions />);
    await fireEvent.press(screen.getByRole("button", { name: "I found someone" }));
    expect(router.push).toHaveBeenCalledWith("/settings/found-them");
    expect(requests.filter((r) => r.method !== "GET")).toHaveLength(0);
    expect(currentSession()).not.toBeNull();
  });

  it("opens the break screen from its button, and nothing happens before that", async () => {
    const requests = fetchMock([]);
    router.push.mockReset();
    await show(<AccountActions />);
    await fireEvent.press(screen.getByRole("button", { name: "Take a break" }));
    expect(router.push).toHaveBeenCalledWith("/account/break");
    expect(requests.filter((r) => r.method !== "GET")).toHaveLength(0);
    expect(currentSession()).not.toBeNull();
  });

  it("hands the export's file to the share sheet by its URL alone, and deletes the cached copy after", async () => {
    const calls = fetchMock([
      (req) => (new URL(req.url).pathname === "/account/export" ? zip() : null),
    ]);
    let whileOpen: number[] | undefined;
    const share = jest.fn(async () => {
      whileOpen = bytesOf(cache.get(`file:///cache/${ZIP_NAME}`));
      return { action: "sharedAction" as const };
    });
    await show(<AccountActions share={share as never} />);
    await fireEvent.press(screen.getByRole("button", { name: "Download my data" }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(share.mock.calls[0]).toEqual([
      { title: "Your Kuutti data", url: `file:///cache/${ZIP_NAME}` },
    ]);
    // The file was there for the sheet, as the API sent it, and is gone once the sheet closed.
    expect(whileOpen).toEqual(Array.from(ZIP));
    await waitFor(() => expect(cache.has(`file:///cache/${ZIP_NAME}`)).toBe(false));
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${session.accessToken}`);
  });

  it("deletes the cached copy even when the sheet fails", async () => {
    fetchMock([(req) => (new URL(req.url).pathname === "/account/export" ? zip() : null)]);
    const share = jest.fn(async () => {
      throw new Error("no sheet");
    });
    await show(<AccountActions share={share as never} />);
    await fireEvent.press(screen.getByRole("button", { name: "Download my data" }));
    expect(await screen.findByText("The download did not work. Try again.")).toBeTruthy();
    expect(cache.has(`file:///cache/${ZIP_NAME}`)).toBe(false);
  });

  it("says the day's copies are used up when the API refuses the fourth, not that it failed", async () => {
    fetchMock([
      (req) =>
        new URL(req.url).pathname === "/account/export"
          ? json({ error: { code: "export_budget_exceeded", message: "x", requestId: "r" } }, 429)
          : null,
    ]);
    const share = jest.fn();
    await show(<AccountActions share={share as never} />);
    await fireEvent.press(screen.getByRole("button", { name: "Download my data" }));
    expect(
      await screen.findByText(
        "That is enough copies for today. You can download your data again after midnight.",
      ),
    ).toBeTruthy();
    expect(share).not.toHaveBeenCalled();
    expect(screen.queryByText("The download did not work. Try again.")).toBeNull();
  });

  it("says so when the export fails", async () => {
    fetchMock([
      (req) =>
        new URL(req.url).pathname === "/account/export"
          ? json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500)
          : null,
    ]);
    await show(<AccountActions share={jest.fn() as never} />);
    await fireEvent.press(screen.getByRole("button", { name: "Download my data" }));
    expect(await screen.findByText("The download did not work. Try again.")).toBeTruthy();
  });

  it("deletes only after the confirmation, with confirm true, and signs the device out", async () => {
    const requests = fetchMock([
      (req) =>
        req.method === "POST" && new URL(req.url).pathname === "/account/delete"
          ? new Response(null, { status: 204 })
          : null,
    ]);
    // The card reads the consents on mount (the research switch); only writes count here.
    const calls = {
      get length() {
        return requests.filter((r) => r.method !== "GET").length;
      },
      at: (i: number) => requests.filter((r) => r.method !== "GET")[i],
    };
    await show(<AccountActions />);
    await fireEvent.press(screen.getByRole("button", { name: "Delete my account" }));
    expect(await screen.findByText("Delete your account?")).toBeTruthy();
    expect(screen.getByText(/A new account is possible after 30 days/)).toBeTruthy();
    expect(calls).toHaveLength(0);
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);

    await fireEvent.press(screen.getByRole("button", { name: "Keep my account" }));
    await settle();
    expect(calls).toHaveLength(0);
    expect(currentSession()?.sessionId).toBe(session.sessionId);

    await fireEvent.press(screen.getByRole("button", { name: "Delete my account" }));
    await fireEvent.press(await screen.findByRole("button", { name: "Delete everything" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(await (calls.at(0) as Request).text())).toEqual({ confirm: true });
    await waitFor(() => expect(currentSession()).toBeNull());
    // Signed out: the card is gone with the session.
    await waitFor(() =>
      expect(
        screen.queryByText(
          "A file with everything Kuutti holds about you, and nothing about anyone else.",
        ),
      ).toBeNull(),
    );
  });

  it("keeps the session when the deletion fails and says so", async () => {
    fetchMock([
      (req) =>
        req.method === "POST"
          ? json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500)
          : null,
    ]);
    await show(<AccountActions />);
    await fireEvent.press(screen.getByRole("button", { name: "Delete my account" }));
    await fireEvent.press(await screen.findByRole("button", { name: "Delete everything" }));
    expect(await screen.findByText("The deletion did not go through. Try again.")).toBeTruthy();
    expect(currentSession()?.sessionId).toBe(session.sessionId);
  });

  it("hands the export to the phone's own share sheet when no other is given", async () => {
    fetchMock([(req) => (new URL(req.url).pathname === "/account/export" ? zip() : null)]);
    const share = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" });
    await show(<AccountActions />);
    await fireEvent.press(screen.getByRole("button", { name: "Download my data" }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    share.mockRestore();
  });

  it("says it is preparing the data while the export runs, and holds both buttons", async () => {
    fetchMock([
      (req) =>
        new URL(req.url).pathname === "/account/export"
          ? (new Promise<Response>(() => undefined) as unknown as Response)
          : null,
    ]);
    await show(<AccountActions share={jest.fn() as never} />);
    await fireEvent.press(screen.getByRole("button", { name: "Download my data" }));
    expect(await screen.findByText("Preparing your data…")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Delete my account" }).props.accessibilityState?.disabled,
    ).toBe(true);
  });

  it("closes the deletion question from its close control without deleting", async () => {
    const requests = fetchMock([]);
    await show(<AccountActions />);
    await fireEvent.press(screen.getByRole("button", { name: "Delete my account" }));
    expect(await screen.findByText("Delete your account?")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    await settle();
    expect(screen.queryByText("Delete your account?")).toBeNull();
    expect(requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });

  it("shows nothing for a signed-out device", async () => {
    await clearSession();
    fetchMock([]);
    await show(<AccountActions />);
    expect(
      screen.queryByText(
        "A file with everything Kuutti holds about you, and nothing about anyone else.",
      ),
    ).toBeNull();
  });
});

describe("shareExport on Android", () => {
  afterEach(() => {
    pickDirectory.mockReset();
    pickDirectory.mockImplementation(async () => new Directory("content://picked"));
  });

  it("writes the file into the folder the person picks, and opens no sheet", async () => {
    const os = jest.replaceProperty(Platform, "OS", "android");
    try {
      const share = jest.fn();
      await shareExport({ name: ZIP_NAME, bytes: ZIP }, "Your Kuutti data", share);
      expect(share).not.toHaveBeenCalled();
      expect(bytesOf(cache.get(`content://picked/${ZIP_NAME}`))).toEqual(Array.from(ZIP));
      expect(cache.has(`file:///cache/${ZIP_NAME}`)).toBe(false);
    } finally {
      os.restore();
      cache.clear();
    }
  });

  it("treats a cancelled picker as nothing to do, and any other failure as one", async () => {
    const os = jest.replaceProperty(Platform, "OS", "android");
    try {
      pickDirectory.mockRejectedValueOnce(
        Object.assign(new Error("The file picker was cancelled by the user"), {
          code: "ERR_PICKER_CANCELLED",
        }),
      );
      await expect(
        shareExport({ name: ZIP_NAME, bytes: ZIP }, "Your Kuutti data", jest.fn()),
      ).resolves.toBeUndefined();
      expect(cache.size).toBe(0);
      pickDirectory.mockRejectedValueOnce(new Error("no storage"));
      await expect(
        shareExport({ name: ZIP_NAME, bytes: ZIP }, "Your Kuutti data", jest.fn()),
      ).rejects.toThrow("no storage");
    } finally {
      os.restore();
    }
  });
});

describe("shareExport on the web preview", () => {
  it("downloads the zip under the API's name instead of sharing it, and lets the URL go later", async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, "OS", "web");
    const click = jest.fn();
    const anchor: { href?: string; download?: string; click: jest.Mock } = { click };
    const globals = globalThis as unknown as {
      document?: unknown;
      URL: { createObjectURL?: unknown; revokeObjectURL?: unknown };
    };
    globals.document = { createElement: jest.fn(() => anchor) };
    const created = jest.fn(() => "blob:kuutti/1");
    const revoked = jest.fn();
    const original = { create: globals.URL.createObjectURL, revoke: globals.URL.revokeObjectURL };
    globals.URL.createObjectURL = created;
    globals.URL.revokeObjectURL = revoked;
    try {
      const share = jest.fn();
      await shareExport({ name: ZIP_NAME, bytes: ZIP }, "Your Kuutti data", share);
      expect(share).not.toHaveBeenCalled();
      expect(anchor).toMatchObject({ href: "blob:kuutti/1", download: ZIP_NAME });
      expect(click).toHaveBeenCalledTimes(1);
      const [blob] = created.mock.calls[0] as unknown as [Blob];
      expect(blob.type).toBe("application/zip");
      expect(blob.size).toBe(ZIP.byteLength);
      expect(revoked).not.toHaveBeenCalled();
      jest.advanceTimersByTime(60_000);
      expect(revoked).toHaveBeenCalledWith("blob:kuutti/1");
    } finally {
      os.restore();
      delete globals.document;
      globals.URL.createObjectURL = original.create;
      globals.URL.revokeObjectURL = original.revoke;
      jest.useRealTimers();
    }
  });
});
