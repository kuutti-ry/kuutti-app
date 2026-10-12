import * as Sentry from "@sentry/react-native";
import { type UpdatesApi, updateApp } from "./app-update";

// The way out for an app older than its API: the newest update for this
// build, then a restart into it; or "none", and only a new install helps.

const captured = Sentry.captureException as jest.Mock;

jest.mock("expo-updates", () => ({
  checkForUpdateAsync: jest.fn(async () => ({ isAvailable: false })),
  fetchUpdateAsync: jest.fn(),
  reloadAsync: jest.fn(),
}));

function updates(available: boolean, fail?: "check" | "fetch") {
  const calls: string[] = [];
  const api = {
    async checkForUpdateAsync() {
      calls.push("check");
      if (fail === "check") throw new Error("not supported in a development build");
      return { isAvailable: available };
    },
    async fetchUpdateAsync() {
      calls.push("fetch");
      if (fail === "fetch") throw new Error("download failed");
      return {};
    },
    async reloadAsync() {
      calls.push("reload");
    },
  } as unknown as UpdatesApi;
  return { api, calls };
}

beforeEach(() => captured.mockClear());

describe("updateApp", () => {
  it("fetches the newest update and restarts into it", async () => {
    const { api, calls } = updates(true);
    expect(await updateApp(api)).toBe("restarting");
    expect(calls).toEqual(["check", "fetch", "reload"]);
  });

  it("asks expo-updates itself when nothing else is handed in", async () => {
    const Updates = jest.requireMock("expo-updates") as { checkForUpdateAsync: jest.Mock };
    expect(await updateApp()).toBe("none");
    expect(Updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
  });

  it("answers none when this build has no newer update, and fetches nothing", async () => {
    const { api, calls } = updates(false);
    expect(await updateApp(api)).toBe("none");
    expect(calls).toEqual(["check"]);
    expect(captured).not.toHaveBeenCalled();
  });

  it("answers none, and reports why, when the build cannot update itself or the download fails", async () => {
    for (const fail of ["check", "fetch"] as const) {
      const { api, calls } = updates(true, fail);
      expect(await updateApp(api)).toBe("none");
      expect(calls).not.toContain("reload");
    }
    expect(captured).toHaveBeenCalledTimes(2);
  });
});
