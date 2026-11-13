import { resolve } from "node:path";
import { vi } from "vitest";

// `pnpm demo:bank` as its tests run it (demo-bank.test.ts and the attacks
// beside it, #380): in this process, with the file system a stand-in, so that
// no test ever writes services/mock-idp/login.html.

const stand = vi.hoisted(() => ({
  page: undefined as string | undefined,
  written: [] as [string, string][],
  read: [] as string[],
}));
// Vitest refuses to export a hoisted variable itself.
export const disk = stand;

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const fake = {
    ...real,
    readFileSync: (path: unknown) => {
      stand.read.push(String(path));
      if (stand.page === undefined) throw new Error(`ENOENT: no such file, open '${String(path)}'`);
      return stand.page;
    },
    writeFileSync: (path: unknown, data: unknown) => {
      stand.written.push([String(path), String(data)]);
    },
  };
  return { ...fake, default: fake };
});

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

export async function run(args: string[]) {
  vi.resetModules();
  const result = { code: 0 as number | undefined, out: [] as string[], err: [] as string[] };
  const argv = process.argv;
  process.argv = [process.execPath, resolve(import.meta.dirname, "demo-bank.ts"), ...args];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    result.out.push(String(line));
  });
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    result.err.push(String(line));
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Exit(code);
  }) as never);
  try {
    await import("./demo-bank.ts");
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    result.code = error.code;
  } finally {
    vi.restoreAllMocks();
    process.argv = argv;
  }
  return result;
}
