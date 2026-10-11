/**
 * Writes the mock bank's login page from the personas (#73, ADR-014).
 *   pnpm demo:bank            writes services/mock-idp/login.html
 *   pnpm demo:bank --check    exits 1 when the file is not what would be written
 * The page is committed: docker compose mounts it, and a clean checkout must
 * start. The container reads it at every login, so a new page needs no restart.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderBankPage } from "../seed/bank-page.ts";
import { DEMO_PERSONAS } from "../seed/personas.ts";

const BANK_PAGE_PATH = resolve(import.meta.dirname, "../../../../services/mock-idp/login.html");

const page = renderBankPage(DEMO_PERSONAS);
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(BANK_PAGE_PATH, "utf8");
  } catch {
    // A missing file is a file that differs.
  }
  if (current !== page) {
    console.error("✖ services/mock-idp/login.html is stale: run `pnpm demo:bank` and commit it");
    process.exit(1);
  }
  console.log(`✔ demo:bank: the login page matches its ${DEMO_PERSONAS.length} personas`);
} else {
  writeFileSync(BANK_PAGE_PATH, page);
  console.log(`✔ demo:bank: ${DEMO_PERSONAS.length} personas to services/mock-idp/login.html`);
}
