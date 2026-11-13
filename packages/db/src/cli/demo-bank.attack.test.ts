import { beforeEach, describe, expect } from "vitest";
import { attack } from "../test/attack.ts";
import { disk, run } from "./run-demo-bank.ts";

// Attacks on `pnpm demo:bank` (#380; #235): a check asked for in a way that is
// not the flag must not be read as no flag, which writes the page. The file
// system is the tests' stand-in, so a write that got through lands nowhere.

beforeEach(() => {
  disk.page = undefined;
  disk.written.length = 0;
  disk.read.length = 0;
});

const wrote = async (args: string[]): Promise<{ wrote: boolean }> => {
  await run(args);
  return { wrote: disk.written.length > 0 };
};

describe("pnpm demo:bank, asked to check", () => {
  // The control is the command with no word at all, which is the write.
  for (const [how, args] of [
    ["a long dash a pasted line carries", ["—check"]],
    ["capitals", ["--CHECK"]],
    ["one dash", ["-check"]],
    ["two separators before the flag", ["--", "--", "--check"]],
  ] as const) {
    attack(`demo:bank: a check asked for with ${how} writes the page`, {
      attempt: () => wrote([...args]),
      control: () => wrote([]),
      succeeds: (seen) => expect(seen.wrote).toBe(true),
    });
  }
});
