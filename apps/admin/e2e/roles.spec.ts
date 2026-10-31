import { expect, signInAsModerator, test } from "./fixtures.ts";

// A screen the role does not open (#302, #304): the menu leaves it out, and at its path it answers
// with its heading and the refusal, asking the API for nothing. The API's guard is what refuses
// (its route tests, per role); the panel never sends the request.

for (const [path, heading] of [
  ["/ponds", "Ponds"],
  ["/config", "Tunables"],
  ["/audit", "Audit log"],
  ["/staff", "Staff"],
] as const) {
  test(`an admin's screen at ${path} is refused to a moderator without asking the API`, async ({
    page,
  }) => {
    // Straight to the screen, as from a link or a bookmark: the bank returns there, and no other
    // screen, the front page's overview included, is ever shown to ask for anything.
    await signInAsModerator(page, path);
    await expect(page.getByRole("heading", { level: 2, name: heading })).toBeVisible();
    await expect(page.getByText("Your role does not allow this.")).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: heading }),
    ).toHaveCount(0);

    // Loaded afresh, the shell checks the stored session (whoami), and the screen asks nothing.
    const asked: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/admin/")) asked.push(request.url());
    });
    await page.reload();
    await expect(page.getByText("Signed in as moderator")).toBeVisible();
    await expect(page.getByText("Your role does not allow this.")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(asked.map((url) => new URL(url).pathname)).toEqual(["/admin/whoami"]);
  });
}
