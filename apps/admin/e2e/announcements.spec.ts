import { ADMIN_APPROVER, ADMIN_WRITER, expect, signIn, test } from "./fixtures.ts";

// An announcement to everybody (#573, ADR-068 §2): one admin writes it, and it waits; the
// panel offers its writer no approval. Another admin approves it through a confirm step that
// says what sending does and to how many, and it goes. Under the host's CSP, with the console
// held clean by the fixture. Both admins are granted by e2e/run.ts; nothing else signs in as
// them. Its branches (refusals, the Swedish rule, deleting) are Announcements.test.tsx's.

const TITLE = "A short break on Sunday";

test("one admin writes an announcement, and another approves and sends it", async ({ page }) => {
  await signIn(page, ADMIN_WRITER, "/announcements");
  await expect(page.getByText("Signed in as admin")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Announcements" })).toBeVisible();

  const english = page.getByRole("group", { name: "English" });
  await english.getByLabel("Title").fill(TITLE);
  await english.getByLabel("Text").fill("Kuutti is closed on Sunday from 10 to 12.");
  const finnish = page.getByRole("group", { name: "Finnish" });
  await finnish.getByLabel("Title").fill("Lyhyt tauko sunnuntaina");
  await finnish.getByLabel("Text").fill("Kuutti on suljettu sunnuntaina kello 10–12.");
  await page.getByRole("button", { name: "Save for a second admin" }).click();
  await expect(page.getByText("Saved. It waits for another admin's approval.")).toBeVisible();

  const waiting = page
    .getByRole("heading", { name: "Waiting for a second admin" })
    .locator("xpath=ancestor::section[1]");
  const draft = waiting.getByRole("listitem").filter({ hasText: TITLE });
  await expect(draft.getByText("You wrote this, so another admin approves it.")).toBeVisible();
  await expect(draft.getByRole("button", { name: "Approve and send" })).toHaveCount(0);
  await expect(draft.getByText("Not written: Swedish readers get the English.")).toBeVisible();

  // Signed out first: a reload before the sign-out lands would send the ended token once more.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in with your bank" })).toBeVisible();
  await signIn(page, ADMIN_APPROVER, "/announcements");
  await expect(page.getByText("Signed in as admin")).toBeVisible();
  const theirs = page
    .getByRole("heading", { name: "Waiting for a second admin" })
    .locator("xpath=ancestor::section[1]")
    .getByRole("listitem")
    .filter({ hasText: TITLE });
  const approve = theirs.getByRole("button", { name: "Approve and send" });
  await approve.click();

  const step = page.getByRole("dialog", { name: "Send this announcement to everybody?" });
  await expect(step).toContainText(
    /It goes now to every account as a notice in the app \(\d+ accounts?\)/,
  );
  await expect(step).toContainText("Nothing takes it back.");
  await expect(step).toBeFocused();
  await page.setViewportSize({ width: 320, height: 550 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  const bounds = await step.boundingBox();
  expect(bounds).not.toBeNull();
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await step.getByRole("button", { name: "Send to everybody" }).scrollIntoViewIfNeeded();
  await expect(step.getByRole("button", { name: "Send to everybody" })).toBeInViewport();
  await expect(step.getByRole("button", { name: "Cancel" })).toBeInViewport();
  await page.setViewportSize({ width: 1000, height: 550 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "100%";
  });
  let approvals = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/approve")) approvals += 1;
  });
  await page.keyboard.press("Enter");
  await expect(step).toBeVisible();
  expect(approvals).toBe(0);
  // The step keeps the focus inside, and Escape gives it back to the button that opened it.
  await page.keyboard.press("Escape");
  await expect(step).toHaveCount(0);
  await expect(approve).toBeFocused();

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/admin/announcements/*/approve", async (route) => {
    await held;
    await route.continue();
  });
  await approve.click();
  await page
    .getByRole("dialog", { name: "Send this announcement to everybody?" })
    .getByRole("button", { name: "Send to everybody" })
    .click();
  const cancel = step.getByRole("button", { name: "Cancel" });
  await expect(cancel).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await expect(step).toBeVisible();
  await cancel.click({ force: true });
  await expect(step).toBeVisible();
  expect(approvals).toBe(1);
  release();
  await expect(page.getByText("Sent to everybody.")).toBeVisible();
  await expect(page.getByText("Sent to everybody.")).toBeFocused();
  const sent = page
    .getByRole("heading", { name: "Sent", exact: true })
    .locator("xpath=ancestor::section[1]");
  await expect(sent.getByRole("listitem").filter({ hasText: TITLE })).toBeVisible();
});
