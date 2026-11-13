import { describe, expect } from "vitest";
import { attack } from "../test/attack.ts";
import {
  assertDemoTarget,
  assertStagingProcess,
  type DemoTarget,
  parseDemoCommand,
} from "./command.ts";

// Attacks on where the synthetic population may be written (#380; #73,
// ADR-014 §10, ADR-018): the arguments, the server asked and the staging
// process, each made to let through what it must refuse. All of it is asked of
// functions: nothing connects anywhere.

/** What the command line comes to: the command it would go on with, or nothing when it refuses. */
const parsed = (argv: readonly string[], appEnv?: string) => {
  try {
    return { ...parseDemoCommand(argv, appEnv), goesAhead: true };
  } catch {
    return { goesAhead: false, action: "none", size: 0 };
  }
};

describe("the population's command line", () => {
  attack("demo:population: production named after the separator pnpm hands through is written to", {
    attempt: () => parsed(["--", "--env", "production"]),
    control: () => parsed(["--", "--env", "preview"]),
    succeeds: (seen) => expect(seen.goesAhead).toBe(true),
  });

  // Each row asks for a dry run in a way that is not the flag; its control is the same line without that word.
  for (const [how, attempt, control] of [
    ["a long dash a pasted line carries", ["—dry-run"], []],
    ["capitals", ["--DRY-RUN"], []],
    ["=true after it", ["--dry-run=true"], []],
    ["the flag before it taking it for its value", ["--size", "--dry-run"], ["--size", "40"]],
  ] as const) {
    attack(`demo:population: a dry run asked for with ${how} is a write`, {
      attempt: () => parsed(attempt),
      control: () => parsed(control),
      succeeds: (seen) => expect(seen.action).toBe("write"),
    });
  }

  for (const [how, over, most] of [
    ["as it stands", "5001", "5000"],
    ["with a zero before it", "05001", "05000"],
  ] as const) {
    attack(`demo:population: one person more than the most there may be, ${how}, is planned`, {
      attempt: () => parsed(["--size", over]),
      control: () => parsed(["--size", most]),
      succeeds: (seen) => expect(seen.goesAhead).toBe(true),
    });
  }
});

describe("the server the population would go to", () => {
  /** A managed server, asked for as a preview: whether the database is let through as a pull request's own. */
  const preview = (database: string): { taken: boolean } => {
    const target: DemoTarget = {
      database,
      user: "kuutti_preview",
      host: "127.0.0.1",
      port: 15432,
      managed: true,
    };
    try {
      assertDemoTarget(target, "preview");
      return { taken: true };
    } catch {
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
});

describe("the staging process (ADR-018)", () => {
  const passes = (appEnv: string): { passes: boolean } => {
    try {
      assertStagingProcess({ APP_ENV: appEnv, PATH: "/usr/bin" });
      return { passes: true };
    } catch {
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
});
