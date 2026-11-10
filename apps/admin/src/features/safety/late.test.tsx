import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n.ts";
import { Late } from "./late.tsx";

// What has waited past its hours (#303), as the overview, the report queue and
// the automatic bans mark it.

afterEach(cleanup);

describe("Late", () => {
  it("follows the words before it after a space, in words and with a silent clock", () => {
    render(
      <I18nProvider i18n={i18n}>
        <p data-testid="line">
          Reports
          <Late hours={24} />
        </p>
      </I18nProvider>,
    );
    expect(screen.getByTestId("line").textContent).toBe("Reports Late (response time: 24 h)");
    const mark = screen.getByText("Late (response time: 24 h)");
    expect(mark.tagName).toBe("STRONG");
    expect(mark.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
