import { describe, expect, it, vi } from "vitest";
import { attack } from "../test/attack.ts";
import * as command from "./command.ts";

// Attacks on where the synthetic population may be written (#380; #73,
// ADR-014 §10, ADR-018): the arguments, the server asked and the staging
// process, each made to let through what it must refuse. All of it is asked of
// functions: nothing connects anywhere.

/** What the command line comes to: the command it would go on with, or nothing when it refuses. */
const parsed = (argv: readonly string[], reason: string) => {
  try {
    return { ...command.parseDemoCommand(argv, undefined), goesAhead: true };
  } catch (error) {
    if (!(error instanceof command.DemoCommandError)) throw error;
    expect(error.message).toContain(reason);
    return { goesAhead: false, action: "none", size: 0 };
  }
};

describe("the population's command line", () => {
  attack("demo:population: production named after the separator pnpm hands through is written to", {
    attempt: () => parsed(["--", "--env", "production"], 'refusing: --env is "production"'),
    control: () => parsed(["--", "--env", "preview"], 'refusing: --env is "production"'),
    succeeds: (seen) => expect(seen.goesAhead).toBe(true),
  });

  // Each row asks for a dry run in a way that is not the flag; its control is the same line without that word.
  for (const [how, attempt, control, reason] of [
    ["a long dash a pasted line carries", ["—dry-run"], [], "unknown argument —dry-run:"],
    ["capitals", ["--DRY-RUN"], [], "unknown argument --DRY-RUN:"],
    ["=true after it", ["--dry-run=true"], [], "--dry-run takes no value"],
    [
      "the flag before it taking it for its value",
      ["--size", "--dry-run"],
      ["--size", "40"],
      "--size takes a whole number, not --dry-run",
    ],
  ] as const) {
    attack(`demo:population: a dry run asked for with ${how} is a write`, {
      attempt: () => parsed(attempt, reason),
      control: () => parsed(control, reason),
      succeeds: (seen) => expect(seen.action).toBe("write"),
    });
  }

  for (const [how, over, most] of [
    ["as it stands", "5001", "5000"],
    ["with a zero before it", "05001", "05000"],
  ] as const) {
    attack(`demo:population: one person more than the most there may be, ${how}, is planned`, {
      attempt: () => parsed(["--size", over], "a population is 1 to 5000 people, not 5001"),
      control: () => parsed(["--size", most], "a population is 1 to 5000 people, not 5001"),
      succeeds: (seen) => expect(seen.goesAhead).toBe(true),
    });
  }

  it.each([new TypeError("broken parser"), new Error("failed import")])(
    "does not turn an unexpected parser error into a refusal: %s",
    (error) => {
      const spy = vi.spyOn(command, "parseDemoCommand").mockImplementationOnce(() => {
        throw error;
      });
      try {
        expect(() => parsed(["--env", "production"], "refusing:")).toThrow(error);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("does not count a different domain refusal as the rule under attack", () => {
    const spy = vi.spyOn(command, "parseDemoCommand").mockImplementationOnce(() => {
      throw new command.DemoCommandError("unknown argument --env");
    });
    try {
      expect(() => parsed(["--env", "production"], 'refusing: --env is "production"')).toThrow(
        /refusing:/,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the server the population would go to", () => {
  /** A managed server, asked for as a preview: whether the database is let through as a pull request's own. */
  const preview = (database: string): { taken: boolean } => {
    const target: command.DemoTarget = {
      database,
      user: "kuutti_preview",
      host: "127.0.0.1",
      port: 15432,
      managed: true,
    };
    try {
      command.assertDemoTarget(target, "preview");
      return { taken: true };
    } catch (error) {
      if (!(error instanceof command.DemoCommandError)) throw error;
      expect(error.message).toContain(`refusing: database "${database}" is on a managed server`);
      return { taken: false };
    }
  };

  for (const [how, database] of [
    ["goes on after the number", "kuutti_pr_88_copy"],
    ["is in capitals", "KUUTTI_PR_88"],
    ["ends in a line break", "kuutti_pr_88\n"],
    ["has a digit of another script", "kuutti_pr_8８"],
  ] as const) {
    attack(
      `demo:population: a managed database whose name ${how} is taken for a pull request's own`,
      {
        attempt: () => preview(database),
        control: () => preview("kuutti_pr_88"),
        succeeds: (seen) => expect(seen.taken).toBe(true),
      },
    );
  }

  it("does not turn a broken target check into a refusal", () => {
    const error = new TypeError("broken target check");
    const spy = vi.spyOn(command, "assertDemoTarget").mockImplementationOnce(() => {
      throw error;
    });
    try {
      expect(() => preview("kuutti_pr_88_copy")).toThrow(error);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the staging process (ADR-018)", () => {
  const passes = (appEnv: string): { passes: boolean } => {
    try {
      command.assertStagingProcess({ APP_ENV: appEnv, PATH: "/usr/bin" });
      return { passes: true };
    } catch (error) {
      if (!(error instanceof command.DemoCommandError)) throw error;
      expect(error.message).toContain(`refusing: APP_ENV is "${appEnv}"`);
      return { passes: false };
    }
  };

  for (const [how, appEnv] of [
    ["only begins with staging", "staging-2"],
    ["is staging with a space after it", "staging "],
    ["is staging in capitals", "STAGING"],
  ] as const) {
    attack(`the demo on staging: a process whose APP_ENV ${how} is taken for staging's container`, {
      attempt: () => passes(appEnv),
      control: () => passes("staging"),
      succeeds: (seen) => expect(seen.passes).toBe(true),
    });
  }

  it("does not turn a broken staging check into a refusal", () => {
    const error = new TypeError("broken staging check");
    const spy = vi.spyOn(command, "assertStagingProcess").mockImplementationOnce(() => {
      throw error;
    });
    try {
      expect(() => passes("STAGING")).toThrow(error);
    } finally {
      spy.mockRestore();
    }
  });
});
