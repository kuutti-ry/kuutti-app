import { expect, signIn, signInAsModerator, test } from "./fixtures.ts";

// The staff sign-in through the bank (#49, ADR-006) under the host's CSP (ADR-025): the panel's
// build as it ships, the headers of infra/modules/admin/main.tf, the mock bank's login.

test("a moderator signs in at the bank and sees what waits", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await signInAsModerator(page);
  await expect(page.getByRole("heading", { name: "What waits" })).toBeVisible();
  // Each queue says how many wait and since when, whatever the other flows have decided already.
  const queues = page.getByRole("main").getByRole("listitem");
  for (const queue of ["Reports", "Automatic shadow bans", "Photo review queue", "Feedback"]) {
    await expect(queues.filter({ has: page.getByRole("link", { name: queue }) })).toHaveText(
      new RegExp(`^${queue} (\\d+ waits?\\. Oldest: .+|nothing waits\\.)$`),
    );
  }
  // The menu offers what the role opens and nothing else (#302).
  const menu = page.getByRole("navigation", { name: "Screens" });
  await expect(menu.getByRole("link", { name: "Tunables" })).toHaveCount(0);
  // A queue's name leads to it.
  await page.getByRole("link", { name: "Photo review queue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Photo review queue" })).toBeFocused();
});

test("the bank returns staff to the screen they asked for (#302)", async ({ page }) => {
  await signInAsModerator(page, "/photos");
  await expect(page).toHaveURL(/\/photos$/);
  await expect(page.getByRole("heading", { name: "Photo review queue" })).toBeVisible();
});

test("a bank login without a staff role is refused in words", async ({ page }) => {
  await signIn(page, "Sanna Korhonen");
  await expect(page.getByRole("alert")).toHaveText(
    "That bank login has no moderator role. Ask the maintainer to add it.",
  );
  await expect(page.getByRole("button", { name: "Sign in with your bank" })).toBeEnabled();
});

test("the host's CSP is in force: a style written at run time is refused", async ({
  page,
  problems,
}) => {
  const answer = await page.goto("/");
  expect(answer?.headers()["content-security-policy"]).toContain("style-src 'self'");
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = "body { outline: 1px solid; }";
    document.head.append(style);
  });
  // The guard sees the refusal twice, as the event and as the console's error; this flow takes
  // back those two, having caused them on purpose, and leaves anything else to fail it.
  const event = (p: string) => p.startsWith("CSP: style-src");
  const said = (p: string) => p.startsWith("console error: ") && p.includes("style-src");
  await expect.poll(() => problems.some(event)).toBe(true);
  await expect.poll(() => problems.some(said)).toBe(true);
  problems.splice(0, problems.length, ...problems.filter((p) => !event(p) && !said(p)));
});
