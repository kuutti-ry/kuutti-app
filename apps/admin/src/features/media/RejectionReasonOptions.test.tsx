import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n.ts";
import { RejectionReasonOptions } from "./RejectionReasonOptions.tsx";
import { REJECTION_REASONS } from "./reasons.ts";

afterEach(cleanup);

describe("RejectionReasonOptions", () => {
  it("offers no reason chosen first, which cannot be chosen, then every reason in order", () => {
    render(
      <I18nProvider i18n={i18n}>
        <select aria-label="Reason" defaultValue="">
          <RejectionReasonOptions />
        </select>
      </I18nProvider>,
    );
    const options = Array.from((screen.getByLabelText("Reason") as HTMLSelectElement).options);
    expect(options[0]).toMatchObject({ value: "", text: "Choose a reason", disabled: true });
    expect(options.slice(1).map((option) => option.value)).toEqual(
      REJECTION_REASONS.map((reason) => reason.value),
    );
    expect(options[1]?.text).toBe("Nudity");
  });
});
