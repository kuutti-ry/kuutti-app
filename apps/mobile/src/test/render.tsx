import { render } from "@testing-library/react-native";
import type * as React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider } from "@/features/identity";
import { LocaleProvider } from "@/lib/locale";
import { PhotoDescriptionsProvider } from "@/lib/photo-descriptions";
import { ThemeProvider } from "@/theme/ThemeProvider";

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** The providers the root layout supplies: safe area, language, theme, the photo descriptions setting and session. */
export function underProviders(ui: React.ReactElement) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <LocaleProvider>
        <ThemeProvider>
          <PhotoDescriptionsProvider>
            <SessionProvider>{ui}</SessionProvider>
          </PhotoDescriptionsProvider>
        </ThemeProvider>
      </LocaleProvider>
    </SafeAreaProvider>
  );
}

/** Renders under those providers. For new props on the same screen: `rerender(underProviders(...))`. */
export function renderWithTheme(ui: React.ReactElement) {
  return render(underProviders(ui));
}
