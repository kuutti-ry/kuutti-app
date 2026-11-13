import { resolve } from "node:path";
import { vi } from "vitest";

// The package's command lines as their tests run them (commands.test.ts and
// the attacks beside it, #380): in this process, with the file system, git and
// the Anthropic client replaced. Nothing reads or writes a real file, runs git
// or reaches the network: a write lands in `disk.written`, and the
// translator's client is a stand-in that answers from `api`.

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
            model: "claude-opus-5-5",
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

export const ROOT = resolve(import.meta.dirname, "..");
export const REPO = resolve(ROOT, "..", "..");
export const MESSAGES = resolve(ROOT, "messages.yaml");

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const SCRIPTS = {
  "build.ts": () => import("./build.ts"),
  "check.ts": () => import("./check.ts"),
  "check-ui-strings.ts": () => import("./check-ui-strings.ts"),
  "check-legal-versions.ts": () => import("./check-legal-versions.ts"),
  "review.ts": () => import("./review.ts"),
  "translate.ts": () => import("./translate.ts"),
};

type Run = { code: number | undefined; out: string[]; err: string[]; stdout: string };

/** Runs a command line as `node scripts/<script> ...args` would, and says what it printed and how it ended. */
export async function run(
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

// Vitest refuses to export a hoisted variable where it is declared.
export { api, disk, git };
