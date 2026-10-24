import { test as base, expect, type Page } from "@playwright/test";

// What every flow shares (#106, ADR-051): the guard that fails a flow on anything the panel's
// console says, an uncaught error or a CSP violation, and the staff sign-in at the mock bank.
// The guard listens on the panel's origin only: the mock bank's page is not the panel's to answer
// for.

export const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ page, baseURL }, use) => {
      if (!baseURL) throw new Error("no panel to test: run the flows with pnpm e2e:admin");
      const panel = new URL(baseURL).origin;
      const onPanel = () => URL.canParse(page.url()) && new URL(page.url()).origin === panel;
      const problems: string[] = [];
      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type()) && onPanel()) {
          problems.push(`console ${message.type()}: ${message.text()}`);
        }
      });
      page.on("pageerror", (error) => {
        if (onPanel()) problems.push(`uncaught: ${error.message}`);
      });
      // Bound and injected by the browser's own protocol, so the CSP under test does not refuse them.
      await page.exposeFunction("cspViolation", (what: string) => problems.push(`CSP: ${what}`));
      await page.addInitScript((origin) => {
        if (location.origin !== origin) return;
        document.addEventListener("securitypolicyviolation", (event) => {
          const report = (window as unknown as { cspViolation: (what: string) => void })
            .cspViolation;
          report(`${event.effectiveDirective} refused ${event.blockedURI || "an inline"}`);
        });
      }, panel);
      await use(problems);
      expect(problems, "the panel's console stays clean and its CSP refuses nothing").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** The moderator of every local stack, granted the role by e2e/run.ts. */
const MODERATOR = "Mikael Lindqvist";

/** The staff sign-in as a person does it: the panel's button, a persona at the bank, back. */
export async function signIn(page: Page, persona = MODERATOR, path = "/"): Promise<void> {
  await page.goto(path);
  await page.getByRole("button", { name: "Sign in with your bank" }).click();
  await page.getByRole("button", { name: persona, exact: true }).click();
}

/** Signs in as the moderator and waits for the shell to say so. */
export async function signInAsModerator(page: Page, path = "/"): Promise<void> {
  await signIn(page, MODERATOR, path);
  await expect(page.getByText("Signed in as moderator")).toBeVisible();
}
