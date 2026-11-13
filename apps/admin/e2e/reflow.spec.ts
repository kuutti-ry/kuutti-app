import { ADMIN_WRITER, expect, signIn, test } from "./fixtures.ts";

// #380: the ordinary desktop control and narrow, enlarged-text attempt render the same
// real screens. A growing label or grid must not push a decision outside the viewport.
test("staff screens keep their controls within a narrow page with enlarged text", async ({
  page,
}, testInfo) => {
  await signIn(page, ADMIN_WRITER, "/matching");
  await expect(page.getByText("Signed in as admin")).toBeVisible();
  const person = process.env.E2E_PERSON_ACCOUNT;
  if (!person) throw new Error("the runner must provide its own person's account");
  const check = async () => {
    for (const width of [1000, 320]) {
      await page.setViewportSize({ width, height: 550 });
      await page.evaluate((large) => {
        document.documentElement.style.fontSize = large ? "200%" : "100%";
      }, width === 320);
      const dimensions = await page.evaluate(() => ({
        viewport: innerWidth,
        page: document.documentElement.scrollWidth,
      }));
      expect(dimensions.page, `${page.url()} at ${width}px`).toBeLessThanOrEqual(
        dimensions.viewport,
      );
      for (const card of await page.getByRole("main").locator('[data-slot="card"]').all()) {
        const size = await card.evaluate((node) => ({
          width: node.clientWidth,
          content: node.scrollWidth,
        }));
        expect(
          size.content,
          `a card (${(await card.textContent())?.slice(0, 60)}) on ${page.url()} at ${width}px`,
        ).toBeLessThanOrEqual(size.width);
      }
    }
  };
  for (const [path, title] of [
    ["/matching", "Matching"],
    ["/announcements", "Announcements"],
    [`/accounts/${person}`, "Account"],
    ["/reports", "Reports"],
  ] as const) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { level: 2, name: new RegExp(`^${title}(?: |$)`) }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    await check();
  }
  await page.getByRole("link", { name: /^Harassment, from a conversation/ }).click();
  await expect(page.getByRole("heading", { level: 2, name: /^Report / })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await check();
  await page.screenshot({ path: testInfo.outputPath("report-large-text.png"), fullPage: true });
});
