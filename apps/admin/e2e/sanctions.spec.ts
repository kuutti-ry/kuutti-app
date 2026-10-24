import type { Page } from "@playwright/test";
import { expect, signInAsModerator, test } from "./fixtures.ts";

// A person's page and the actions on it (#306, #308): reached by an account id at the lookup, as
// a moderator does with one copied from a report or a feedback row. The person is Riikka, a card
// in Iida's round (e2e/run.ts), whom nothing else in the flows touches.

const person = () => {
  const account = process.env.E2E_PERSON_ACCOUNT;
  if (!account) throw new Error("no person to act on: run the flows with pnpm e2e:admin");
  return account;
};

/** Opens the person's page from the lookup, and gives its card of sanctions. */
async function openThePage(page: Page) {
  await signInAsModerator(page, "/accounts");
  await page.getByLabel("Account id").fill(person());
  await page.getByRole("button", { name: "Open the page" }).click();
  await expect(page).toHaveURL(new RegExp(`/accounts/${person()}$`));
  const sanctions = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole("heading", { name: "Sanctions", exact: true }) });
  await expect(sanctions).toBeVisible();
  return sanctions;
}

test("a suspension is applied through its confirm step and lifted through another", async ({
  page,
}) => {
  const sanctions = await openThePage(page);
  await expect(sanctions.getByText("None.")).toBeVisible();

  await sanctions.getByRole("button", { name: "Suspend until a day" }).click();
  const apply = page.getByRole("dialog", { name: "Suspend this person" });
  await expect(apply).toContainText("Ends every session now and refuses the bank login");
  const confirm = apply.getByRole("button", { name: "Apply" });
  await expect(confirm).toBeDisabled();
  await apply.getByLabel("Reason").selectOption({ label: "Harassment" });
  await apply.getByLabel("Note: what happened, in a few words").fill("Unkind words in a round.");
  // The day after the earliest the field takes, so a run across midnight still asks a later day.
  const ends = apply.getByLabel("Suspended until the start of this day");
  const earliest = new Date(`${await ends.getAttribute("min")}T12:00:00Z`);
  earliest.setUTCDate(earliest.getUTCDate() + 1);
  await ends.fill(earliest.toISOString().slice(0, 10));
  await confirm.click();
  await expect(apply).toBeHidden();
  await expect(page.getByRole("status")).toHaveText("Applied: Suspension.");
  const entry = sanctions.getByRole("listitem").filter({ hasText: "Unkind words in a round." });
  await expect(entry).toContainText("Suspension");

  await entry.getByRole("button", { name: "Lift" }).click();
  const lift = page.getByRole("dialog", { name: "Lift: Suspension" });
  await expect(lift).toContainText("The person may sign in again");
  await lift.getByRole("button", { name: "Lift" }).click();
  await expect(lift).toBeHidden();
  await expect(page.getByRole("status")).toHaveText("Lifted: Suspension.");
  await expect(entry).toContainText(/Lifted: .+ Who: /);
  await expect(entry.getByRole("button", { name: "Lift" })).toHaveCount(0);
});

test("a confirm step is kept by the keyboard and gives the focus back", async ({ page }) => {
  const sanctions = await openThePage(page);
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") sent.push(`${request.method()} ${request.url()}`);
  });
  const warn = sanctions.getByRole("button", { name: "Warn" });
  await warn.focus();
  await page.keyboard.press("Enter");
  const step = page.getByRole("dialog", { name: "Warn this person" });
  await expect(step).toBeVisible();

  // The focus goes inside, to the first control, and Tab and Shift+Tab wrap around within the step.
  const reason = step.getByLabel("Reason");
  const cancel = step.getByRole("button", { name: "Cancel" });
  await expect(reason).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(reason).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(step.getByLabel("Note: what happened, in a few words")).toBeFocused();
  // The page behind cannot be reached while the step is open.
  await expect(page.locator("#root")).toHaveAttribute("inert", "");

  // Escape closes it from wherever the focus is, and the focus returns to what opened it.
  await page.keyboard.press("Escape");
  await expect(step).toBeHidden();
  await expect(warn).toBeFocused();
  // Nothing was sent on the way: no step that writes was taken.
  expect(sent).toEqual([]);
});
