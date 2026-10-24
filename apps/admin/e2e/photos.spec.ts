import { expect, signInAsModerator, test } from "./fixtures.ts";

// The photo review queue (#49, #253): locally every upload waits for a person (MODERATION=queue),
// so the stories leave Noa's photos here. Each picture comes from the S3 stand-in through a URL
// the API presigns, which the host's img-src admits only in this run (e2e/run.ts).

test("a moderator approves one photo and rejects another for a reason, and the count goes down", async ({
  page,
}) => {
  await signInAsModerator(page, "/photos");
  const total = page.getByText(/^(\d+ photos? waiting|Nothing waiting)$/);
  await expect(total).toHaveText(/waiting$/);
  const before = Number((await total.textContent())?.match(/^\d+/)?.[0] ?? 0);
  expect(before, "the stories leave at least two photos in review").toBeGreaterThanOrEqual(2);
  const waiting = (n: number) =>
    n === 0 ? "Nothing waiting" : n === 1 ? "1 photo waiting" : `${n} photos waiting`;

  const items = page.getByRole("main").getByRole("list").first().locator(":scope > li");
  const first = items.nth(0);
  const second = items.nth(1);

  // The picture itself, through its signed URL, under the CSP.
  const picture = first.getByRole("img", { name: "Photo under review" });
  await expect(picture).toBeVisible();
  await expect
    .poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);

  await first.getByRole("button", { name: "Approve" }).click();
  await expect(first).toHaveText("Approved");
  await expect(total).toHaveText(waiting(before - 1));

  // No reason is preset (#250): the rejection waits for one chosen on purpose.
  await second.getByRole("button", { name: "Reject…" }).click();
  const reject = second.getByRole("button", { name: "Reject photo" });
  await expect(reject).toBeDisabled();
  await second.getByLabel("Reason the person is told").selectOption({ label: "No person visible" });
  await reject.click();
  await expect(second).toHaveText("Rejected");
  await expect(total).toHaveText(waiting(before - 2));
});
