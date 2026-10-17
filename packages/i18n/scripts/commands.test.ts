import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compile } from "./lib/compile.ts";
import { reviewHash } from "./lib/review-hash.ts";
import { parseMessages } from "./lib/schema.ts";

// The command lines of the package, run in this process (#13, #55): each
// option, each refusal and each exit code, with the file system, git and the
// Anthropic client replaced. Nothing here reads or writes a real file, runs
// git or reaches the network: a write lands in `disk.written`, and the
// translator's client is a stand-in that answers from `api`. cli.test.ts runs
// a few of the same refusals as real processes.

const disk = vi.hoisted(() => ({
  files: new Map<string, string | Uint8Array>(),
  written: new Map<string, string>(),
  made: [] as string[],
  removed: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const missing = (path: string) =>
    Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
      code: "ENOENT",
    });
  const under = (dir: string) =>
    [...disk.files.keys()].filter((path) => path.startsWith(`${dir}/`));
  const fake = {
    ...real,
    readFileSync: (path: unknown, encoding?: unknown) => {
      const value = disk.files.get(String(path));
      if (value === undefined) throw missing(String(path));
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      return encoding ? new TextDecoder().decode(bytes) : Buffer.from(bytes);
    },
    writeFileSync: (path: unknown, data: unknown) => {
      disk.written.set(String(path), String(data));
      disk.files.set(String(path), String(data));
    },
    existsSync: (path: unknown) => disk.files.has(String(path)),
    mkdirSync: (path: unknown) => {
      disk.made.push(String(path));
    },
    unlinkSync: (path: unknown) => {
      disk.removed.push(String(path));
      disk.files.delete(String(path));
    },
    readdirSync: (dir: unknown) => {
      const entries = under(String(dir)).map(
        (path) => path.slice(String(dir).length + 1).split("/")[0] as string,
      );
      if (entries.length === 0) throw missing(String(dir));
      return [...new Set(entries)].sort();
    },
    statSync: (path: unknown) => ({ isDirectory: () => under(String(path)).length > 0 }),
  };
  return { ...fake, default: fake };
});

const git = vi.hoisted(() => ({
  calls: [] as string[][],
  show: (_args: string[]): string => {
    throw new Error("git is not expected here");
  },
}));

vi.mock("node:child_process", () => ({
  execFileSync: (command: string, args: string[]) => {
    git.calls.push([command, ...args]);
    return git.show(args);
  },
}));

const api = vi.hoisted(() => ({
  clients: 0,
  answer: (_keys: string[], _locale: string): unknown => ({ translations: [] }),
  batch: { id: "msgbatch_1" } as { id: string },
  submitted: [] as unknown[],
  processing: "ended",
  results: [] as unknown[],
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class StandIn {
    constructor() {
      api.clients += 1;
    }
    beta = {
      messages: {
        parse: async (params: { messages: { content: string }[]; system: { text: string }[] }) => {
          const sent = JSON.parse(params.messages[0]?.content ?? "{}") as {
            items: { key: string }[];
          };
          const locale = params.system[0]?.text.includes("into Finnish.") ? "fi" : "sv";
          const answer = api.answer(
            sent.items.map((item) => item.key),
            locale,
          );
          if (answer instanceof Error) throw answer;
          return {
            model: "claude-opus-5",
            stop_reason: "end_turn",
            stop_details: null,
            usage: { input_tokens: 1, output_tokens: 1 },
            parsed_output: answer,
          };
        },
      },
    };
    messages = {
      batches: {
        create: async (params: unknown) => {
          api.submitted.push(params);
          return api.batch;
        },
        retrieve: async () => ({
          processing_status: api.processing,
          request_counts: { processing: 2, succeeded: 1, errored: 0, canceled: 0, expired: 0 },
        }),
        results: async () =>
          (async function* () {
            yield* api.results;
          })(),
      },
    };
  },
}));

const ROOT = resolve(import.meta.dirname, "..");
const REPO = resolve(ROOT, "..", "..");
const MESSAGES = resolve(ROOT, "messages.yaml");

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const SCRIPTS = {
  "build.ts": () => import("./build.ts"),
  "check.ts": () => import("./check.ts"),
  "check-ui-strings.ts": () => import("./check-ui-strings.ts"),
  "review.ts": () => import("./review.ts"),
  "translate.ts": () => import("./translate.ts"),
};

type Run = { code: number | undefined; out: string[]; err: string[]; stdout: string };

/** Runs a command line as `node scripts/<script> ...args` would, and says what it printed and how it ended. */
async function run(
  script: keyof typeof SCRIPTS,
  args: string[] = [],
  env: { GITHUB_ACTIONS?: string } = {},
): Promise<Run> {
  vi.resetModules();
  const result: Run = { code: 0, out: [], err: [], stdout: "" };
  const argv = process.argv;
  const actions = process.env.GITHUB_ACTIONS;
  process.argv = [process.execPath, resolve(ROOT, "scripts", script), ...args];
  process.env.GITHUB_ACTIONS = env.GITHUB_ACTIONS ?? "false";
  const spies = [
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      result.out.push(parts.join(" "));
    }),
    vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      result.err.push(parts.join(" "));
    }),
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      result.stdout += String(chunk);
      return true;
    }),
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Exit(code);
    }) as never),
  ];
  try {
    await SCRIPTS[script]();
    result.code = Number(process.exitCode ?? 0);
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    result.code = error.code;
  } finally {
    for (const spy of spies) spy.mockRestore();
    process.exitCode = undefined;
    process.argv = argv;
    process.env.GITHUB_ACTIONS = actions;
  }
  return result;
}

const HELLO_FI = reviewHash("Goodbye", "Näkemiin");

/** A small messages.yaml: machine text, a current review, a missing Swedish, an English-only key. */
const SOURCE = `demo.greeting:
  en: Hello
  description: Greeting.
  fi: Hei
  sv: Hej
  machine: { fi: true, sv: true }
demo.bye:
  en: Goodbye
  description: Last screen.
  fi: Näkemiin
  reviewed: { fi: "${HELLO_FI}" }
admin.title:
  en: Admin
  description: English only.
`;

beforeEach(() => {
  disk.files.clear();
  disk.written.clear();
  disk.made.length = 0;
  disk.removed.length = 0;
  disk.files.set(MESSAGES, SOURCE);
  git.calls.length = 0;
  api.clients = 0;
  api.submitted.length = 0;
  api.results = [];
  api.processing = "ended";
  api.batch = { id: "msgbatch_1" };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pnpm i18n:build", () => {
  it("writes the compiled modules of messages.yaml to src/generated", async () => {
    const result = await run("build.ts");
    expect(result.code).toBe(0);
    const out = resolve(ROOT, "src", "generated");
    expect(disk.made).toEqual([out]);
    const expected = compile(parseMessages(SOURCE));
    expect([...disk.written.keys()].sort()).toEqual(
      Object.keys(expected)
        .map((file) => resolve(out, file))
        .sort(),
    );
    expect(disk.written.get(resolve(out, "fi.ts"))).toBe(expected["fi.ts"]);
    expect(result.out).toEqual(["✔ i18n:build: 3 keys to src/generated"]);
  });

  it("compiles nothing from a file that breaks the rules", async () => {
    disk.files.set(MESSAGES, `${SOURCE}demo.save:\n  en: Save\n  description: A button.\n`);
    const result = await run("build.ts");
    expect(result.code).toBe(1);
    expect(result.err).toEqual(["✖ demo.save: no fi text (Finnish is required)"]);
    expect(disk.written.size).toBe(0);
  });
});

describe("pnpm i18n:check", () => {
  it("passes a clean file and counts what waits for a reviewer", async () => {
    const result = await run("check.ts");
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      "! admin.title: no sv text".replace("admin.title", "demo.bye"),
      "✔ i18n:check: 3 keys, 0 errors, 1 warnings, 1 Finnish texts awaiting a native review (pnpm i18n:review)",
    ]);
  });

  it("fails a release on machine Finnish, and says it checked a release", async () => {
    const result = await run("check.ts", ["--release"]);
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      "✖ demo.greeting: fi is still machine-translated; a release needs a native review",
    ]);
    expect(result.out.at(-1)).toMatch(/^✖ i18n:check --release: 3 keys, 1 errors, 1 warnings/);
  });

  it("checks a release after the -- that pnpm passes through", async () => {
    const result = await run("check.ts", ["--", "--release"]);
    expect(result.out.at(-1)).toMatch(/^✖ i18n:check --release: 3 keys, 1 errors, 1 warnings/);
  });

  it("annotates the pull request in GitHub Actions, escaped so a text cannot start a command", async () => {
    disk.files.set(
      MESSAGES,
      SOURCE.replace("  en: Hello\n", '  en: "Hello\\n::stop-commands::x"\n'),
    );
    const result = await run("check.ts", ["--release"], { GITHUB_ACTIONS: "true" });
    expect(result.out[0]).toBe("::warning::demo.bye: no sv text");
    expect(result.err.every((line) => line.startsWith("::error::"))).toBe(true);
    expect(result.err.join("\n")).not.toMatch(/\n::stop-commands/);
  });

  it("counts a review gone stale among the texts that wait", async () => {
    disk.files.set(MESSAGES, SOURCE.replace("  en: Goodbye", "  en: Goodbye now"));
    const result = await run("check.ts");
    expect(result.code).toBe(1);
    expect(result.out.at(-1)).toMatch(/2 Finnish texts awaiting a native review/);
  });

  it("stops on a file that does not parse, with the reason", async () => {
    disk.files.set(MESSAGES, "Hello: world\n");
    const result = await run("check.ts");
    expect(result.code).toBe(1);
    expect(result.err[0]).toMatch(/^✖ messages\.yaml is not valid:/);
  });
});

describe("pnpm lint's check:ui-strings", () => {
  const file = (path: string, text: string) => disk.files.set(resolve(REPO, path), text);

  beforeEach(() => {
    file("apps/mobile/app/index.tsx", "export const A = () => <Text>{t('home.title')}</Text>;\n");
    file("apps/mobile/src/lib/clock.ts", "export const now = () => Date.now();\n");
    file("apps/admin/src/App.tsx", "export const App = () => <main>{t('admin.title')}</main>;\n");
  });

  it("passes clean screens and says how many files it read", async () => {
    const result = await run("check-ui-strings.ts");
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      "✔ check:ui-strings: 3 files, no inline user-facing strings, no date formatted outside @kuutti/i18n",
    ]);
  });

  it("names an inline string and a date formatted outside the package, by file, line and column", async () => {
    file(
      "apps/mobile/src/features/home/Card.tsx",
      "const x = 1;\nexport const C = () => <Text>Hello</Text>;\n",
    );
    file(
      "apps/admin/src/lib/when.ts",
      "export const when = (d: Date) =>\n  d.toLocaleDateString();\n",
    );
    const result = await run("check-ui-strings.ts");
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      expect.stringMatching(
        /^✖ apps\/mobile\/src\/features\/home\/Card\.tsx:2:\d+ inline string "Hello" \(.+\): add a key to packages\/i18n\/messages\.yaml and use t\(\)$/,
      ),
      "✖ apps/admin/src/lib/when.ts:2:5 date formatted outside @kuutti/i18n (toLocaleDateString(): use formatDate, formatDateTime or formatTime, d.M.yyyy on every screen",
    ]);
  });

  it.each([
    ["Intl.DateTimeFormat", "new Intl.DateTimeFormat('fi').format(d)", 5],
    ["dateStyle", "d.toString({ dateStyle: 'short' })", 14],
    ["timeStyle", "x({ timeStyle : 'short' })", 5],
    ["toLocaleTimeString", "d.toLocaleTimeString ()", 3],
    ["toUTCString", "d.toUTCString()", 3],
  ])("refuses %s in code", async (_, code, column) => {
    file("apps/mobile/src/x.ts", `const d = new Date();\n${code};\n`);
    const result = await run("check-ui-strings.ts");
    expect(result.err).toEqual([
      expect.stringMatching(new RegExp(`^✖ apps/mobile/src/x\\.ts:2:${column} `)),
    ]);
  });

  it("lets a comment name the API, and leaves tests and test folders alone", async () => {
    file(
      "apps/mobile/src/notes.ts",
      "// toLocaleDateString() is banned here\n/* Intl.DateTimeFormat\n   dateStyle: no */\nexport {};\n",
    );
    file("apps/mobile/src/Card.test.tsx", "<Text>Hello</Text>; d.toLocaleDateString();\n");
    file("apps/mobile/src/test/render.tsx", "<Text>Hello</Text>;\n");
    file("apps/mobile/src/readme.md", "toLocaleDateString()\n");
    expect((await run("check-ui-strings.ts")).code).toBe(0);
  });

  it("annotates the file in GitHub Actions", async () => {
    file("apps/admin/src/Bad.tsx", "export const B = () => <p>Hi</p>;\n");
    const result = await run("check-ui-strings.ts", [], { GITHUB_ACTIONS: "true" });
    expect(result.err).toEqual([
      expect.stringMatching(
        /^::error file=apps\/admin\/src\/Bad\.tsx,line=1,col=\d+::inline string "Hi"/,
      ),
    ]);
  });
});

describe("pnpm i18n:review", () => {
  it("shows the progress per namespace and how much is machine text", async () => {
    const result = await run("review.ts");
    expect(result.code).toBe(0);
    expect(result.out[0]?.split("\n")[1]).toMatch(/^demo\s+1\s+1\s+0\s+0\s+1\s+0$/);
    expect(result.out[1]).toBe(
      "\n1 fi and 1 sv texts are machine text. docs/i18n/translation-review-guide.md describes the review.",
    );
  });

  it("shows the progress as Markdown for a CI summary, and nothing else", async () => {
    const result = await run("review.ts", ["--markdown"]);
    expect(result.out).toHaveLength(1);
    expect(result.out[0]).toContain("| demo | 1 | 1 | 0 | 0 | 1 | 0 |");
  });

  it("does one thing at a time", async () => {
    const result = await run("review.ts", ["--approve", "--reflag", "--locale", "fi", "demo.bye"]);
    expect(result.code).toBe(1);
    expect(result.err).toEqual(["✖ --approve and --reflag are different commands; give one"]);
    expect(disk.written.size).toBe(0);
  });

  describe("--list", () => {
    it("lists what waits in each language, with the English and the text", async () => {
      const result = await run("review.ts", ["--list"]);
      expect(result.out).toEqual([
        "fi: 1 texts waiting for a native review",
        "  demo.greeting\n    en: Hello\n    fi: Hei",
        "sv: 1 texts waiting for a native review",
        "  demo.greeting\n    en: Hello\n    sv: Hej",
      ]);
    });

    it("narrows to a language, a prefix, or the reviews gone stale", async () => {
      disk.files.set(MESSAGES, SOURCE.replace("  en: Goodbye", "  en: Goodbye now"));
      expect((await run("review.ts", ["--list", "--locale", "fi", "--stale"])).out).toEqual([
        "fi: 1 texts waiting for a native review",
        "  demo.bye\n    en: Goodbye now\n    fi: Näkemiin",
      ]);
      expect(
        (await run("review.ts", ["--list", "--locale", "sv", "--prefix", "other."])).out,
      ).toEqual(["sv: 0 texts waiting for a native review"]);
    });

    it("refuses a language that is not translated", async () => {
      const result = await run("review.ts", ["--list", "--locale", "en"]);
      expect(result).toMatchObject({ code: 1, err: ["✖ --locale is fi or sv"] });
    });
  });

  describe("--export", () => {
    it("prints a sheet to stdout, or writes it to --out", async () => {
      const printed = await run("review.ts", ["--export", "tsv", "--locale", "fi"]);
      expect(printed.stdout.startsWith("\ufeffkey\twhere it shows")).toBe(true);
      expect(printed.stdout).toContain("demo.greeting\tGreeting.\tHello\tHei");

      const out = resolve(REPO, "sheet.md");
      const written = await run("review.ts", [
        "--export",
        "md",
        "--locale",
        "sv",
        "--all",
        "--out",
        out,
      ]);
      expect(written.out).toEqual([`Wrote 1 sv texts to ${out}.`]);
      expect(disk.written.get(out)).toContain("| `demo.greeting` |");
    });

    it.each([
      [["--export", "csv", "--locale", "fi"], "✖ --export is tsv or md"],
      [["--export", "tsv"], "✖ --locale is fi or sv"],
    ])("refuses %o", async (args, message) => {
      expect(await run("review.ts", args)).toMatchObject({ code: 1, err: [message] });
    });
  });

  describe("--import", () => {
    const sheetPath = resolve(REPO, "back.tsv");
    const sheet = (rows: string[][]) =>
      `key\ten\tfi\tapprove\tfingerprint\n${rows.map((row) => row.join("\t")).join("\n")}\n`;
    const greeting = (fi: string, approve: string) => [
      "demo.greeting",
      "Hello",
      fi,
      approve,
      reviewHash("Hello", "Hei"),
    ];

    it("writes the approvals and the corrections, and says so", async () => {
      disk.files.set(sheetPath, sheet([greeting("Moi", "x")]));
      const result = await run("review.ts", ["--import", sheetPath, "--locale", "fi"]);
      expect(result.code).toBe(0);
      expect(result.out).toEqual([
        "Approved (1):",
        "  demo.greeting",
        "0 rows unchanged.",
        "Imported 1 approvals and 0 corrections. Now run `pnpm i18n:build` and commit messages.yaml with src/generated.",
      ]);
      expect(parseMessages(disk.written.get(MESSAGES) ?? "")["demo.greeting"]).toMatchObject({
        fi: "Moi",
        reviewed: { fi: reviewHash("Hello", "Moi") },
      });
    });

    it("writes nothing on a dry run, and nothing when nothing changed", async () => {
      disk.files.set(sheetPath, sheet([greeting("Moi", "")]));
      const dry = await run("review.ts", ["--import", sheetPath, "--locale", "fi", "--dry-run"]);
      expect(dry.out).toEqual([
        "Corrected, still waiting for approval (1):",
        "  demo.greeting",
        "0 rows unchanged.",
        "(dry run: messages.yaml not written) Imported 0 approvals and 1 corrections",
      ]);
      disk.files.set(sheetPath, sheet([greeting("Hei", "")]));
      const same = await run("review.ts", ["--import", sheetPath, "--locale", "fi"]);
      expect(same.out).toEqual(["1 rows unchanged."]);
      expect(disk.written.has(MESSAGES)).toBe(false);
    });

    it("ends with 1 when a row is refused, naming it", async () => {
      disk.files.set(sheetPath, sheet([["demo.ghost", "x", "y", "x", "0"]]));
      const result = await run("review.ts", ["--import", sheetPath, "--locale", "fi"]);
      expect(result.code).toBe(1);
      expect(result.err).toEqual(["Refused (1):", "  ✖ demo.ghost: not in messages.yaml"]);
    });

    it("stops on a sheet that is not UTF-8, and on one that cannot be read", async () => {
      disk.files.set(sheetPath, Uint8Array.from([0x4e, 0xe4, 0x6b]));
      expect(await run("review.ts", ["--import", sheetPath, "--locale", "fi"])).toMatchObject({
        code: 1,
        err: ["✖ the sheet is not UTF-8 text; save it as tab-separated values (UTF-8)"],
      });
      const missing = await run("review.ts", [
        "--import",
        resolve(REPO, "nope.tsv"),
        "--locale",
        "fi",
      ]);
      expect(missing.code).toBe(1);
      expect(missing.err[0]).toMatch(/^✖ ENOENT/);
    });
  });

  describe("--approve", () => {
    it("approves the named texts and writes the file", async () => {
      const result = await run("review.ts", ["--approve", "--locale", "fi", "demo.*"]);
      expect(result.code).toBe(0);
      expect(result.out).toEqual([
        "Approved (1):",
        "  demo.greeting",
        "  · demo.bye: already reviewed",
        "Approved 1 fi texts. Now run `pnpm i18n:build` and commit messages.yaml with src/generated.",
      ]);
      expect(disk.written.get(MESSAGES)).toContain(
        `reviewed: { fi: "${reviewHash("Hello", "Hei")}" }`,
      );
    });

    it("ends with 1 and writes nothing when every text is refused", async () => {
      const result = await run("review.ts", ["--approve", "--locale", "fi", "admin.title"]);
      expect(result.code).toBe(1);
      expect(result.err).toEqual(["Refused (1):", "  ✖ admin.title: admin.* is English only"]);
      expect(disk.written.size).toBe(0);
    });

    it.each([
      [[], "✖ name the keys: a key, or prefix.* for a namespace"],
      [["demo.ghost", "nope.*"], "✖ no key matches demo.ghost, nope.*"],
    ])("refuses the selection %o", async (keys, message) => {
      expect(await run("review.ts", ["--approve", "--locale", "fi", ...keys])).toMatchObject({
        code: 1,
        err: [message],
      });
    });
  });

  describe("--reflag", () => {
    it("flags a reviewed text again, and passes over machine text", async () => {
      const result = await run("review.ts", [
        "--reflag",
        "--locale",
        "fi",
        "demo.bye",
        "demo.greeting",
      ]);
      expect(result.out).toEqual([
        "Flagged for review again (1):",
        "  demo.bye",
        "  · demo.greeting: machine, nothing to flag",
        "Flagged 1 fi texts. Now run `pnpm i18n:build` and commit messages.yaml with src/generated.",
      ]);
      expect(parseMessages(disk.written.get(MESSAGES) ?? "")["demo.bye"]?.machine).toEqual({
        fi: true,
      });
    });

    it("flags every stale review with --stale, and nothing when there is none", async () => {
      expect((await run("review.ts", ["--reflag", "--locale", "fi", "--stale"])).out).toEqual([]);
      disk.files.set(MESSAGES, SOURCE.replace("  en: Goodbye", "  en: Goodbye now"));
      const result = await run("review.ts", ["--reflag", "--locale", "fi", "--stale", "--dry-run"]);
      expect(result.out.at(-1)).toBe("(dry run: messages.yaml not written) Flagged 1 fi texts");
    });
  });

  describe("--approved-since", () => {
    const before = SOURCE.replace(/ {2}reviewed: .*\n/, "  machine: { fi: true }\n");

    it("names each approval new since the ref, at its line", async () => {
      git.show = () => before;
      const result = await run("review.ts", ["--approved-since", "origin/main"]);
      expect(git.calls).toEqual([
        ["git", "show", "--end-of-options", "origin/main:packages/i18n/messages.yaml"],
      ]);
      expect(result.out).toEqual([
        "fi text approved as a native review: demo.bye. The approval of this pull request is its record; it must be the reviewer's. (line 7)",
      ]);
    });

    it("annotates the line of the file in GitHub Actions", async () => {
      git.show = () => before;
      const result = await run("review.ts", ["--approved-since", "HEAD~1"], {
        GITHUB_ACTIONS: "true",
      });
      expect(result.out).toEqual([
        expect.stringMatching(
          /^::warning file=packages\/i18n\/messages\.yaml,line=7::fi text approved/,
        ),
      ]);
    });

    it("says so when nothing is newly approved", async () => {
      git.show = () => SOURCE;
      expect((await run("review.ts", ["--approved-since", "HEAD"])).out).toEqual([
        "No text newly approved.",
      ]);
    });

    it.each([
      "fatal: path 'packages/i18n/messages.yaml' exists on disk, but not in 'v0.1.0'",
      "fatal: path 'packages/i18n/messages.yaml' does not exist in 'abc123'",
    ])("takes a ref without the file as one where every review is new: %s", async (stderr) => {
      git.show = () => {
        throw Object.assign(new Error("Command failed"), { stderr });
      };
      const result = await run("review.ts", ["--approved-since", "v0.1.0"]);
      expect(result.code).toBe(0);
      expect(result.out).toEqual([
        expect.stringMatching(/^fi text approved as a native review: demo\.bye\./),
      ]);
    });

    it("stops on any other failure, rather than call it nothing new", async () => {
      git.show = () => {
        throw Object.assign(new Error("Command failed"), {
          stderr: "fatal: invalid object name 'nope'.\n",
        });
      };
      expect(await run("review.ts", ["--approved-since", "nope"])).toMatchObject({
        code: 1,
        err: ["✖ could not read messages.yaml at \"nope\": fatal: invalid object name 'nope'."],
      });
      git.show = () => {
        throw new Error("spawnSync git ENOENT");
      };
      expect((await run("review.ts", ["--approved-since", "main"])).err).toEqual([
        '✖ could not read messages.yaml at "main": spawnSync git ENOENT',
      ]);
    });
  });
});

describe("pnpm i18n:translate", () => {
  const GLOSSARY = resolve(ROOT, "glossary.yaml");
  const TONE = resolve(REPO, "docs", "i18n", "tone.md");
  const BATCHES = resolve(ROOT, ".batches");

  /** Two keys without Finnish, one without Swedish, and machine text to write again. */
  const TO_TRANSLATE = `demo.save:
  en: Save
  description: A button.
demo.cancel:
  en: Cancel
  description: A button.
  sv: Avbryt
  machine: { sv: true }
demo.greeting:
  en: Hello
  description: Greeting.
  fi: Hei
  sv: Hej
  machine: { fi: true, sv: true }
admin.title:
  en: Admin
  description: English only.
`;

  const FINNISH: Record<string, string> = {
    "demo.save": "Tallenna",
    "demo.cancel": "Peruuta",
    "demo.greeting": "Moi",
  };

  beforeEach(() => {
    disk.files.set(MESSAGES, TO_TRANSLATE);
    disk.files.set(GLOSSARY, "Kuutti: never translated\n");
    disk.files.set(TONE, "Plain and warm.\n");
    api.answer = (keys, locale) => ({
      translations: keys.map((key) => ({
        key,
        text: locale === "fi" ? (FINNISH[key] ?? "?") : "Spara",
      })),
    });
  });

  it.each([
    [["--locale", "de"], "✖ --locale is fi or sv"],
    [["--chunk-size", "0"], "✖ --chunk-size is a whole number"],
    [["--chunk-size", "2.5"], "✖ --chunk-size is a whole number"],
    [["--chunk-size", "many"], "✖ --chunk-size is a whole number"],
    [["--mode", "async"], "✖ --mode is sync or batch"],
    [["--retranslate", "--stale"], "✖ --retranslate and --stale select different texts; pick one"],
    [["--compare", "--mode", "batch", "--prefix", "demo."], "✖ --compare runs in sync mode"],
    [
      ["--batch-id", "msgbatch_1", "--locale", "fi", "--dry-run"],
      "✖ --batch-id takes no other options (got --locale, --dry-run)",
    ],
    [["--batch-id", "../../etc/passwd"], "✖ that is not a batch id"],
    [["--retranslate"], "✖ --retranslate needs --prefix or --keys"],
    [["--compare"], "✖ --compare needs --prefix or --keys"],
    // Without the refusal these took every namespace, sent it and wrote (#235).
    [["--prefix="], "✖ --prefix takes a value"],
    [["--keys", ""], "✖ --keys takes a value"],
    [["--stale", "--prefix="], "✖ --prefix takes a value"],
    [["--mode", "batch", "--keys="], "✖ --keys takes a value"],
  ])("refuses %o before anything is sent", async (args, message) => {
    const result = await run("translate.ts", args);
    expect(result).toMatchObject({ code: 1, err: [message] });
    expect(api.clients).toBe(0);
    expect(disk.written.size).toBe(0);
  });

  it("plans a dry run per language and request, with its examples, and sends nothing", async () => {
    const result = await run("translate.ts", ["--dry-run", "--chunk-size", "1"]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      "fi: 2 texts (missing) in 2 requests",
      "  request 1: demo, 1 keys, 0 examples\n    demo.save",
      "  request 2: demo, 1 keys, 0 examples\n    demo.cancel",
      "sv: 1 texts (missing) in 1 requests",
      "  request 1: demo, 1 keys, 0 examples\n    demo.save",
      "Dry run: nothing sent.",
    ]);
    expect(api.clients).toBe(0);
  });

  it("says when a language has nothing to translate", async () => {
    const result = await run("translate.ts", [
      "--dry-run",
      "--locale",
      "sv",
      "--keys",
      "demo.cancel",
    ]);
    expect(result.out).toEqual(["sv: nothing to translate (missing)", "Dry run: nothing sent."]);
  });

  it("writes the answers flagged machine: true, and says what to run next", async () => {
    const result = await run("translate.ts");
    expect(result.code).toBe(0);
    expect(api.clients).toBe(1);
    expect(result.out).toEqual([
      "fi: 2 texts (missing) in 1 requests",
      "sv: 1 texts (missing) in 1 requests",
      expect.stringMatching(/^ {2}fi: 2 keys, /),
      "fi: wrote 2, flagged machine: true",
      expect.stringMatching(/^ {2}sv: 1 keys, /),
      "sv: wrote 1, flagged machine: true",
      "Now run `pnpm i18n:build` and commit messages.yaml with src/generated.",
    ]);
    const after = parseMessages(disk.written.get(MESSAGES) ?? "");
    expect(after["demo.save"]).toMatchObject({
      fi: "Tallenna",
      sv: "Spara",
      machine: { fi: true, sv: true },
    });
    expect(after["demo.cancel"]).toMatchObject({ fi: "Peruuta", machine: { sv: true, fi: true } });
  });

  it("reports a failed request's keys and a refused answer, and goes on", async () => {
    api.answer = (keys, locale) =>
      locale === "sv"
        ? new Error("overloaded")
        : {
            translations: keys.map((key) => ({
              key,
              text: key === "demo.save" ? "Katso https://x.example" : "Peruuta",
            })),
          };
    const result = await run("translate.ts");
    expect(result.code).toBe(0);
    expect(result.err).toEqual([
      "✖ fi demo.save: contains a link the English source does not have",
      "✖ sv demo.save: overloaded",
    ]);
    expect(result.out).toContain("fi: wrote 1, flagged machine: true");
    expect(result.out).toContain("sv: wrote 0, flagged machine: true");
    expect(parseMessages(disk.written.get(MESSAGES) ?? "")["demo.cancel"]?.fi).toBe("Peruuta");
  });

  it("writes nothing and says nothing more when every answer is refused", async () => {
    api.answer = (keys) => ({ translations: keys.map((key) => ({ key, text: "" })) });
    const result = await run("translate.ts", ["--locale", "fi"]);
    expect(result.out.at(-1)).toBe("fi: wrote 0, flagged machine: true");
    expect(disk.written.size).toBe(0);
  });

  it("compares machine text with a new answer side by side, writing nothing", async () => {
    api.answer = (keys) => ({
      translations: keys.flatMap((key) =>
        key === "demo.greeting" ? [{ key, text: "Hei {name}" }] : [],
      ),
    });
    const result = await run("translate.ts", ["--compare", "--prefix", "demo.", "--locale", "fi"]);
    expect(result.out).toEqual([
      "fi: 1 texts (retranslate) in 1 requests",
      expect.stringMatching(/^ {2}fi: 1 keys, /),
      '  demo.greeting\n    en:  "Hello"\n    now: "Hei"\n    new: "Hei {name}"\n    ✖ would be refused: does not keep the ICU arguments of the English source',
      "Compare: messages.yaml not written.",
    ]);
    expect(disk.written.size).toBe(0);
  });

  it("shows an answer missing from a compare as none", async () => {
    api.answer = () => ({ translations: [] });
    const result = await run("translate.ts", [
      "--compare",
      "--keys",
      "demo.greeting",
      "--locale",
      "sv",
    ]);
    expect(result.out[2]).toBe(
      '  demo.greeting\n    en:  "Hello"\n    now: "Hej"\n    new: (none)',
    );
  });

  it("selects the reviews gone stale with --stale", async () => {
    disk.files.set(
      MESSAGES,
      `${TO_TRANSLATE}demo.bye:\n  en: Goodbye now\n  description: d.\n  fi: Näkemiin\n  reviewed: { fi: "${HELLO_FI}" }\n`,
    );
    const result = await run("translate.ts", ["--stale", "--dry-run", "--locale", "fi"]);
    expect(result.out).toEqual([
      "fi: 1 texts (stale) in 1 requests",
      "  request 1: demo, 1 keys, 0 examples\n    demo.bye",
      "Dry run: nothing sent.",
    ]);
  });

  it("writes machine text again with --retranslate, under the keys named", async () => {
    const result = await run("translate.ts", [
      "--retranslate",
      "--keys",
      "demo.greeting, demo.save",
      "--locale",
      "fi",
    ]);
    expect(result.out[0]).toBe("fi: 1 texts (retranslate) in 1 requests");
    expect(parseMessages(disk.written.get(MESSAGES) ?? "")["demo.greeting"]?.fi).toBe("Moi");
  });

  describe("in batch mode", () => {
    it("submits every request in one batch and keeps what each asked for until it is collected", async () => {
      const result = await run("translate.ts", ["--mode", "batch"]);
      expect(result.code).toBe(0);
      expect(api.submitted).toHaveLength(1);
      const manifest = JSON.parse(disk.written.get(resolve(BATCHES, "msgbatch_1.json")) ?? "{}");
      expect(manifest).toEqual({
        selection: { mode: "missing" },
        requests: {
          "fi-0000": { locale: "fi", keys: ["demo.save", "demo.cancel"] },
          "sv-0001": { locale: "sv", keys: ["demo.save"] },
        },
        sources: { "demo.save": reviewHash("Save", ""), "demo.cancel": reviewHash("Cancel", "") },
      });
      expect(disk.made).toEqual([BATCHES]);
      expect(result.out.at(-1)).toBe(
        "Submitted batch msgbatch_1 (2 requests). Most finish within an hour, all within 24.\nCollect it with: pnpm i18n:translate --batch-id msgbatch_1",
      );
      expect(disk.written.has(MESSAGES)).toBe(false);
    });

    it("submits nothing when nothing is selected", async () => {
      const result = await run("translate.ts", ["--mode", "batch", "--keys", "admin.title"]);
      expect(api.submitted).toEqual([]);
      expect(result.out).toEqual([
        "fi: nothing to translate (missing)",
        "sv: nothing to translate (missing)",
      ]);
    });

    it("stops when the API names the batch with something that is not a file name", async () => {
      api.batch = { id: "../escape" };
      const result = await run("translate.ts", ["--mode", "batch"]);
      expect(result).toMatchObject({
        code: 1,
        err: ['✖ the batch id is not a file name: "../escape"'],
      });
      expect(disk.written.size).toBe(0);
    });
  });

  describe("collecting a batch", () => {
    const record = resolve(BATCHES, "msgbatch_1.json");
    const manifest = {
      selection: { mode: "missing" },
      requests: {
        "fi-0000": { locale: "fi", keys: ["demo.save", "demo.cancel"] },
        "sv-0001": { locale: "sv", keys: ["demo.save"] },
      },
      sources: { "demo.save": reviewHash("Save", ""), "demo.cancel": reviewHash("Cancel", "") },
    };
    const message = (translations: { key: string; text: string }[]) => ({
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2 },
      content: [{ type: "text", text: JSON.stringify({ translations }) }],
    });

    beforeEach(() => {
      disk.files.set(record, JSON.stringify(manifest));
    });

    it("writes the answers, names the failed requests, and forgets the batch", async () => {
      api.results = [
        {
          custom_id: "fi-0000",
          result: {
            type: "succeeded",
            message: message([
              { key: "demo.save", text: "Tallenna" },
              { key: "demo.cancel", text: "Peruuta" },
              { key: "demo.greeting", text: "Moi" },
            ]),
          },
        },
        { custom_id: "sv-0001", result: { type: "expired" } },
      ];
      const result = await run("translate.ts", ["--batch-id", "msgbatch_1"]);
      expect(result.code).toBe(0);
      expect(result.out).toEqual([
        "fi: wrote 2, flagged machine: true",
        "sv: wrote 0, flagged machine: true",
        "Ignored 1 answers for keys not asked for.",
        "Batch msgbatch_1: 10 input, 0 cache read, 0 cache write, 2 output tokens (at batch prices, half of sync)",
        "Now run `pnpm i18n:build` and commit messages.yaml with src/generated.",
      ]);
      expect(result.err).toEqual([
        "✖ sv demo.save: the translator returned nothing for this key",
        "✖ sv-0001: expired",
      ]);
      expect(disk.removed).toEqual([record]);
      expect(parseMessages(disk.written.get(MESSAGES) ?? "")["demo.save"]?.fi).toBe("Tallenna");
    });

    it("never writes an answer made from an English that changed since", async () => {
      disk.files.set(MESSAGES, TO_TRANSLATE.replace("  en: Save\n", "  en: Save now\n"));
      api.results = [
        {
          custom_id: "fi-0000",
          result: {
            type: "succeeded",
            message: message([
              { key: "demo.save", text: "Tallenna" },
              { key: "demo.cancel", text: "Peruuta" },
            ]),
          },
        },
      ];
      const result = await run("translate.ts", ["--batch-id", "msgbatch_1"]);
      expect(result.err).toEqual([
        "✖ fi demo.save: the English changed since the batch was submitted; translate it again",
        "✖ sv demo.save: the English changed since the batch was submitted; translate it again",
      ]);
      const after = parseMessages(disk.written.get(MESSAGES) ?? "");
      expect(after["demo.save"]?.fi).toBeUndefined();
      expect(after["demo.cancel"]?.fi).toBe("Peruuta");
      expect(result.out).not.toContain("sv: wrote 0, flagged machine: true");
    });

    it("never writes a key that left the file since", async () => {
      disk.files.set(MESSAGES, TO_TRANSLATE.replace(/demo\.save:\n(?: {2}.*\n){2}/, ""));
      api.results = [];
      const result = await run("translate.ts", ["--batch-id", "msgbatch_1"]);
      expect(result.err[0]).toBe(
        "✖ fi demo.save: the English changed since the batch was submitted; translate it again",
      );
    });

    it("waits while the batch runs, and keeps its record", async () => {
      api.processing = "in_progress";
      const result = await run("translate.ts", ["--batch-id", "msgbatch_1"]);
      expect(result.out).toEqual([
        "Batch msgbatch_1 is still running: 2 processing, 1 done, 0 errored. Run `pnpm i18n:translate --batch-id msgbatch_1` again later.",
      ]);
      expect(disk.removed).toEqual([]);
    });

    it("refuses a batch it has no record of, and a record that is not one", async () => {
      expect(await run("translate.ts", ["--batch-id", "msgbatch_9"])).toMatchObject({
        code: 1,
        err: [
          "✖ no record of batch msgbatch_9 in packages/i18n/.batches; it is collected where it was submitted",
        ],
      });
      disk.files.set(
        record,
        JSON.stringify({ ...manifest, requests: { x: { locale: "en", keys: [] } } }),
      );
      await expect(run("translate.ts", ["--batch-id", "msgbatch_1"])).rejects.toThrow();
      expect(disk.written.size).toBe(0);
    });
  });
});
