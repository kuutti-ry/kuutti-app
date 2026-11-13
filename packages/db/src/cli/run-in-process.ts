import { resolve } from "node:path";
import { vi } from "vitest";
import { TEST_DATABASE_URL } from "../test/temporary-database.ts";

// The package's command lines as its tests run them (cli.test.ts and the
// attacks beside it, #380): in this process, with exactly the arguments and
// the environment given.

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const COMMANDS = {
  migrate: () => import("./migrate.ts"),
  seed: () => import("./seed.ts"),
  moderator: () => import("./moderator.ts"),
};

type Run = { code: number | undefined; out: string[]; err: (string | Error)[] };

/** Runs `node src/cli/<command>.ts ...args` in this process, with exactly the environment given. */
export async function run(
  command: keyof typeof COMMANDS,
  args: string[],
  env: { DATABASE_URL?: string; APP_ENV?: string },
): Promise<Run> {
  vi.resetModules();
  const result: Run = { code: 0, out: [], err: [] };
  const saved = { argv: process.argv, url: process.env.DATABASE_URL, app: process.env.APP_ENV };
  process.argv = [process.execPath, resolve(import.meta.dirname, `${command}.ts`), ...args];
  for (const [name, value] of Object.entries({
    DATABASE_URL: env.DATABASE_URL,
    APP_ENV: env.APP_ENV,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const spies = [
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      result.out.push(parts.map(String).join(" "));
    }),
    vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      // The attacks must distinguish a refused connection from a broken command,
      // including a query wrapper's cause. Stringifying an Error loses that evidence.
      result.err.push(
        parts.length === 1 && parts[0] instanceof Error ? parts[0] : parts.map(String).join(" "),
      );
    }),
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Exit(code);
    }) as never),
  ];
  try {
    await COMMANDS[command]();
    result.code = Number(process.exitCode ?? 0);
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    result.code = error.code;
  } finally {
    for (const spy of spies) spy.mockRestore();
    process.exitCode = undefined;
    process.argv = saved.argv;
    for (const [name, value] of Object.entries({ DATABASE_URL: saved.url, APP_ENV: saved.app })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  return result;
}

/** A database of the local server that does not exist: the connection fails, nothing is created. */
export const NOWHERE = (() => {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = "/kuutti_no_such_database";
  return url.toString();
})();
