import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createReactI18n, I18nProvider, useT } from "./react.tsx";

// The React binding of the app and the admin panel (#13): the provider hands
// its instance down, useT() is the typed t() of the nearest provider, and the
// instance from createReactI18n carries react-i18next's plugin. Rendered to a
// string: the binding needs no DOM to show what it does.

/** The provider's props require its children, so they go in with the props. */
const provide = (i18n: Parameters<typeof I18nProvider>[0]["i18n"], ...children: ReactNode[]) =>
  createElement(I18nProvider, { i18n, children });

function Probe() {
  const { t, locale } = useT();
  return createElement("p", { lang: locale }, t("onboarding.retry"));
}

describe("the React binding", () => {
  it.each([
    ["en", "Try again"],
    ["fi", "Yritä uudelleen"],
    ["sv", "Försök igen"],
  ] as const)(
    "renders the %s text and names the language of the nearest provider",
    (locale, text) => {
      const i18n = createReactI18n({ locale });
      expect(renderToStaticMarkup(provide(i18n, createElement(Probe)))).toBe(
        `<p lang="${locale}">${text}</p>`,
      );
    },
  );

  it("lets the nearest provider win over an outer one", () => {
    const outer = createReactI18n({ locale: "en" });
    const inner = createReactI18n({ locale: "fi" });
    const tree = provide(outer, createElement(Probe), provide(inner, createElement(Probe)));
    expect(renderToStaticMarkup(tree)).toBe(
      '<p lang="en">Try again</p><p lang="fi">Yritä uudelleen</p>',
    );
  });

  it("registers react-i18next on the instance, so a screen outside a provider still has t()", () => {
    const i18n = createReactI18n({ locale: "sv" });
    expect(i18n.modules.external.some((module) => module.type === "3rdParty")).toBe(true);
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<p lang="sv">Försök igen</p>');
  });

  it("offers the pseudo-locale when a dev build hands it in", () => {
    const i18n = createReactI18n({
      locale: "en-XA",
      pseudo: { "onboarding.retry": "［Trýý áágááííñ］" },
    });
    expect(renderToStaticMarkup(provide(i18n, createElement(Probe)))).toBe(
      '<p lang="en-XA">［Trýý áágááííñ］</p>',
    );
  });
});
