import { expect, signInAsModerator, test } from "./fixtures.ts";

// A report from the queue to a decision (#311, #312): Laura reported her conversation with Emmi
// (e2e/run.ts), and the moderator reads the frozen copy and dismisses it in its own confirm step.

test("a report is opened and dismissed through its confirm step", async ({ page }) => {
  await signInAsModerator(page, "/reports");
  await expect(page.getByText("1 report waits.")).toBeVisible();
  // One link per report, named by its reason, its source and when it was filed.
  await page.getByRole("link", { name: /^Harassment, from a conversation · Filed / }).click();
  await expect(page.getByRole("heading", { level: 2, name: /^Report / })).toBeVisible();
  await expect(page.getByText("She called me names when I said no.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "The conversation as it was when reported" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  const step = page.getByRole("dialog", { name: "Dismiss the report" });
  await expect(step).toContainText(
    "The report closes with no action on the reported person. The block between the two stays.",
  );
  await step.getByRole("button", { name: "Dismiss report" }).click();
  await expect(step).toBeHidden();
  await expect(page.getByText("Report dismissed.")).toBeVisible();

  await page.getByRole("link", { name: "Back to the reports" }).click();
  await expect(page.getByText("Nothing waits.")).toBeVisible();
});
