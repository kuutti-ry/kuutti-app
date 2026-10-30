import { render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";

// A production build (#55, TD-17): the update channel says so, and the phone
// asks for Swedish first, which is not released.
jest.mock("expo-updates", () => ({ channel: "production" }));
jest.mock("expo-localization", () => ({
  useLocales: jest.fn(() => [{ languageTag: "sv-FI" }, { languageTag: "fi-FI" }]),
}));

import { LocaleProvider, OFFERED_LOCALES, SERVED_LOCALES, useLocaleSettings } from "./locale";

function Device() {
  return <Text testID="device">{useLocaleSettings().deviceLocale}</Text>;
}

describe("a production build", () => {
  it("serves and offers only the released languages", () => {
    expect(SERVED_LOCALES).toEqual(["en", "fi"]);
    expect(OFFERED_LOCALES).not.toContain("sv");
    expect(OFFERED_LOCALES).not.toContain("fi-x-stadi");
  });

  it("skips a language that is not released and takes the phone's next one", async () => {
    const screen = await render(
      <LocaleProvider>
        <Device />
      </LocaleProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("device").props.children).toBe("fi"));
  });
});
