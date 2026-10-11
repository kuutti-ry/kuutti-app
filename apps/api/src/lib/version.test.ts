import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// What the smoke screen and /health say the build is (#16). git is the
// fallback for a developer's commit and is replaced here, so the outcome does
// not depend on the checkout the tests run in.
const git = vi.hoisted(() => ({
  calls: [] as string[],
  answer: "abc1234\n" as string | Error,
}));
vi.mock("node:child_process", () => ({
  execSync: (command: string) => {
    git.calls.push(command);
    if (git.answer instanceof Error) throw git.answer;
    return Buffer.from(git.answer);
  },
}));

// The setup file has loaded version.ts with the real child_process already (harness → app → health): load it anew.
let buildInfo: typeof import("./version.ts").buildInfo;
beforeAll(async () => {
  vi.resetModules();
  ({ buildInfo } = await import("./version.ts"));
});

const injected = {
  APP_VERSION: "1.2.3",
  GIT_COMMIT: "37a837c",
  BUILT_AT: "2026-10-10T12:00:00.000Z",
  NODE_ENV: "production",
} as const;

describe("buildInfo", () => {
  beforeEach(() => {
    git.calls.length = 0;
    git.answer = "abc1234\n";
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names what the image build injected, and never asks git in production", () => {
    expect(buildInfo(injected)).toEqual({
      version: "1.2.3",
      commit: "37a837c",
      builtAt: "2026-10-10T12:00:00.000Z",
    });
    expect(git.calls).toEqual([]);
  });

  it("an injected commit wins over git locally too", () => {
    expect(buildInfo({ ...injected, NODE_ENV: "development" }).commit).toBe("37a837c");
  });

  it("a production build without an injected commit says unknown, not the box's checkout", () => {
    expect(buildInfo({ ...injected, GIT_COMMIT: undefined }).commit).toBe("unknown");
    expect(git.calls).toEqual([]);
  });

  it("locally the commit is git's short HEAD, trimmed", () => {
    expect(buildInfo({ ...injected, GIT_COMMIT: undefined, NODE_ENV: "development" }).commit).toBe(
      "abc1234",
    );
    expect(git.calls).toEqual(["git rev-parse --short HEAD"]);
  });

  it("without git, or outside a checkout, the commit is unknown", () => {
    git.answer = new Error("fatal: not a git repository");
    expect(buildInfo({ ...injected, GIT_COMMIT: undefined, NODE_ENV: "test" }).commit).toBe(
      "unknown",
    );
  });

  it("without an injected build time, the build is as of now", () => {
    vi.useFakeTimers({ now: new Date("2026-10-11T08:30:00.000Z") });
    expect(buildInfo({ ...injected, BUILT_AT: undefined }).builtAt).toBe(
      "2026-10-11T08:30:00.000Z",
    );
  });
});
