import { describe, expect, it } from "vitest";
import { argumentsOf } from "./arguments.ts";

describe("maintenance command arguments", () => {
  it("keeps positional roles separate from flag values, including the same word", () => {
    expect(
      argumentsOf(
        ["--", "--env=test", "grant", "hash", "admin", "--by", "admin"],
        ["--env", "--by"],
      ),
    ).toEqual({
      options: { "--env": "test", "--by": "admin" },
      positionals: ["grant", "hash", "admin"],
    });
  });
  it.each([
    [["--dry-run"], "unknown argument --dry-run"],
    [["--env", "test", "--env=production"], "--env is given twice"],
    [["--env"], "--env takes a value"],
    [["--env", ""], "--env takes a value"],
    [["--env="], "--env takes a value"],
    [["--env", "--by", "someone"], "--env takes a value"],
    [["list", "--"], "unknown argument --"],
  ])("refuses %j before a command can act", (args, reason) => {
    expect(() => argumentsOf(args, ["--env", "--by"])).toThrow(reason);
  });
});
