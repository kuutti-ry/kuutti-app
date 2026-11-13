import { type ExecFileException, execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { command } from "./run-command.ts";

// Keep the real promisify contract: execFile supplies stdout and stderr on
// both success and error. No process, network or clock is needed for its failures.
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { promisify: asPromise } = await import("node:util");
  const mock = vi.fn();
  Object.defineProperty(mock, asPromise.custom, { value: vi.fn() });
  return { ...real, execFile: mock };
});

const spawned = vi.mocked(promisify(execFile));
const failed = (over: Partial<ExecFileException> = {}) =>
  Object.assign(new Error("command failed"), {
    code: 2,
    killed: false,
    signal: null,
    stdout: "",
    stderr: "✖ refusing production",
    ...over,
  });

afterEach(() => spawned.mockReset());

describe("the command attack's process driver", () => {
  it("returns the command's successful output", async () => {
    spawned.mockResolvedValueOnce({ stdout: "the plan\n", stderr: "" });
    await expect(command("demo-population.ts", ["--dry-run"])).resolves.toEqual({
      code: 0,
      stdout: "the plan\n",
      stderr: "",
    });
  });

  it("keeps an ordinary refusal available for an assertion on its code and reason", async () => {
    spawned.mockRejectedValueOnce(failed());
    await expect(command("demo-population.ts", ["--env", "production"])).resolves.toEqual({
      code: 2,
      stdout: "",
      stderr: "✖ refusing production",
    });
  });

  it.each([
    ["failed spawn", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })],
    ["deadline", failed({ code: 1, killed: true, signal: "SIGTERM" })],
    ["signal", failed({ code: 1, signal: "SIGTERM" })],
    ["output limit", Object.assign(failed(), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })],
    ["unexpected exception", new TypeError("broken process fixture")],
    ["invalid exit", failed({ code: 0 })],
    ["missing stdout", Object.assign(failed(), { stdout: undefined })],
    ["missing output", Object.assign(failed(), { stderr: undefined })],
    ["non-error rejection", "broken process fixture"],
  ])("rethrows %s instead of reporting a held rule", async (_kind, error) => {
    spawned.mockRejectedValueOnce(error);
    await expect(command("demo-population.ts", [])).rejects.toBe(error);
  });

  it.each([
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx'",
    "Error: Cannot find module './demo-population.ts'\ncode: 'MODULE_NOT_FOUND'",
    "TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension .ts",
    "Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath is not defined",
    "Error [ERR_UNSUPPORTED_DIR_IMPORT]: Directory import is not supported",
    "Error [ERR_REQUIRE_ESM]: require() of ES Module is not supported",
    "file:///script.ts:3\nSyntaxError: Unexpected token",
    "ReferenceError: missingVar is not defined",
    "TypeError: Cannot read properties of undefined (reading 'env')",
    "RangeError: Maximum call stack size exceeded",
  ])("rethrows a loader or programmer failure: %s", async (stderr) => {
    const error = Object.assign(failed({ code: 1 }), { stderr });
    spawned.mockRejectedValueOnce(error);
    await expect(command("demo-population.ts", [])).rejects.toBe(error);
  });
});
