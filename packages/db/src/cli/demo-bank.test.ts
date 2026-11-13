import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderBankPage } from "../seed/bank-page.ts";
import { DEMO_PERSONAS } from "../seed/personas.ts";
import { disk, run } from "./run-demo-bank.ts";

// `pnpm demo:bank` (#73, ADR-014): writes the mock bank's login page, or with
// --check says whether the committed one is current. The file system is a
// stand-in here: the test never writes services/mock-idp/login.html.

const PAGE_PATH = resolve(import.meta.dirname, "../../../../services/mock-idp/login.html");
const PAGE = renderBankPage(DEMO_PERSONAS);

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

  it("takes --check after the separator pnpm hands through", async () => {
    disk.page = PAGE;
    expect((await run(["--", "--check"])).code).toBe(0);
    expect(disk.read).toEqual([PAGE_PATH]);
    expect(disk.written).toEqual([]);
  });

  // #235: each of these wrote the page, as if no flag had been given.
  it.each([
    [["--check="], "✖ demo:bank: Option '--check' does not take an argument"],
    [["--check=false"], "✖ demo:bank: Option '--check' does not take an argument"],
    [["--chek"], "✖ demo:bank: Unknown option '--chek'"],
    [["check"], "✖ demo:bank: Unexpected argument 'check'"],
  ])("refuses %j before it reads or writes the page", async (args, message) => {
    disk.page = PAGE;
    const result = await run(args);
    expect(result).toEqual({ code: 1, out: [], err: [expect.stringContaining(message)] });
    expect(disk.read).toEqual([]);
    expect(disk.written).toEqual([]);
  });
});
