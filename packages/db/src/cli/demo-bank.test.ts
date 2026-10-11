import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderBankPage } from "../seed/bank-page.ts";
import { DEMO_PERSONAS } from "../seed/personas.ts";

// `pnpm demo:bank` (#73, ADR-014): writes the mock bank's login page, or with
// --check says whether the committed one is current. The file system is a
// stand-in here: the test never writes services/mock-idp/login.html.

const disk = vi.hoisted(() => ({
  page: undefined as string | undefined,
  written: [] as [string, string][],
  read: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const fake = {
    ...real,
    readFileSync: (path: unknown) => {
      disk.read.push(String(path));
      if (disk.page === undefined) throw new Error(`ENOENT: no such file, open '${String(path)}'`);
      return disk.page;
    },
    writeFileSync: (path: unknown, data: unknown) => {
      disk.written.push([String(path), String(data)]);
    },
  };
  return { ...fake, default: fake };
});

const PAGE_PATH = resolve(import.meta.dirname, "../../../../services/mock-idp/login.html");
const PAGE = renderBankPage(DEMO_PERSONAS);

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

async function run(args: string[]) {
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

beforeEach(() => {
  disk.page = undefined;
  disk.written.length = 0;
  disk.read.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pnpm demo:bank", () => {
  it("writes the page of every persona to services/mock-idp/login.html", async () => {
    const result = await run([]);
    expect(result).toEqual({
      code: 0,
      out: [`✔ demo:bank: ${DEMO_PERSONAS.length} personas to services/mock-idp/login.html`],
      err: [],
    });
    expect(disk.written).toEqual([[PAGE_PATH, PAGE]]);
    expect(disk.read).toEqual([]);
  });

  it("passes --check when the committed page is what it would write, and writes nothing", async () => {
    disk.page = PAGE;
    expect(await run(["--check"])).toEqual({
      code: 0,
      out: [`✔ demo:bank: the login page matches its ${DEMO_PERSONAS.length} personas`],
      err: [],
    });
    expect(disk.read).toEqual([PAGE_PATH]);
    expect(disk.written).toEqual([]);
  });

  it.each([
    ["a page that differs", `${PAGE}<!-- edited by hand -->`],
    ["an empty page", ""],
    ["no page at all", undefined],
  ])("fails --check on %s", async (_, page) => {
    disk.page = page;
    expect(await run(["--check"])).toEqual({
      code: 1,
      out: [],
      err: ["✖ services/mock-idp/login.html is stale: run `pnpm demo:bank` and commit it"],
    });
    expect(disk.written).toEqual([]);
  });
});
