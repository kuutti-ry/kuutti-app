import { expect, signInAsModerator, test } from "./fixtures.ts";

// A report from the queue to a decision (#311, #312): Laura reported her conversation with Emmi,
// pointing at the photo Emmi sent her in the stories (#476), and the moderator finds that photo
// first, shows it, reads the frozen copy and dismisses the report in its own confirm step.

test("a report is opened, its pointed photo shown, and dismissed through its confirm step", async ({
  page,
}) => {
  await signInAsModerator(page, "/reports");
  await expect(page.getByText("1 report waits.")).toBeVisible();
  // One link per report, named by its reason, its source and when it was filed.
  await page.getByRole("link", { name: /^Harassment, from a conversation · Filed / }).click();
  await expect(page.getByRole("heading", { level: 2, name: /^Report / })).toBeVisible();
  await expect(page.getByText("She called me names when I said no.")).toBeVisible();
  const copy = page.locator('[data-slot="card"]').filter({
    has: page.getByRole("heading", { name: "The conversation as it was when reported" }),
  });
  await expect(copy).toBeVisible();

  // The line Laura pointed at comes first, said in words, its photo hidden until asked.
  const pointed = copy.getByRole("listitem").first();
  await expect(pointed).toContainText("The reporter pointed at this photo");
  await expect(copy.getByRole("img")).toHaveCount(0);
  await pointed.getByRole("button", { name: "Show photo" }).click();
  const picture = pointed.getByRole("img", { name: /^Photo sent by the reported person\. Sent: / });
  await expect(picture).toBeVisible();
  await expect
    .poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);

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
