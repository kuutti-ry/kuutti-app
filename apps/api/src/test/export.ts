import { AccountExport } from "@kuutti/schema";
import { unzipSync } from "fflate";
import { expect } from "vitest";
import type { App } from "../app.ts";

/**
 * The export as the tests read it (#237): the zip opened, its document
 * parsed against the contract, its photo files by path.
 */
export type OpenedExport = {
  response: Response;
  document: AccountExport;
  /** Every entry of the zip by its path, the document's among them. */
  files: Map<string, Uint8Array>;
};

export async function openExport(response: Response): Promise<OpenedExport> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/zip");
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const files = new Map(Object.entries(entries));
  const json = [...files.keys()].find((path) => path.endsWith(".json"));
  if (!json) throw new Error("no document in the export");
  const document = AccountExport.parse(
    JSON.parse(new TextDecoder().decode(files.get(json) as Uint8Array)),
  );
  return { response, document, files };
}

/** `GET /account/export` as the caller, opened; the document alone is what most tests read. */
export async function exportOf(app: App, headers: Record<string, string>): Promise<AccountExport> {
  return (await openExport(await app.request("/account/export", { headers }))).document;
}
