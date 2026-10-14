import { profileErrorText } from "./errorText";

// The words for a refused save (#223): the table's codes get their own text,
// the rest the generic line. `t` returns its key, so the test reads keys.
const t = ((key: string) => key) as unknown as Parameters<typeof profileErrorText>[1];

describe("profileErrorText", () => {
  it("names a refusal it has words for", () => {
    expect(profileErrorText({ kind: "error", code: "text_contact_details" }, t)).toBe(
      "profile.error.text_contact_details",
    );
    expect(profileErrorText({ kind: "error", code: "consent_required" }, t)).toBe(
      "errors.special_category_locked",
    );
  });

  it("says the generic line for any other code, for none, and for no notice", () => {
    expect(profileErrorText({ kind: "error", code: "validation_failed" }, t)).toBe(
      "profile.error.generic",
    );
    expect(profileErrorText({ kind: "error", code: undefined }, t)).toBe("profile.error.generic");
    expect(profileErrorText(null, t)).toBe("profile.error.generic");
  });
});
