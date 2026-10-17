import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { fireEvent, screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { Linking } from "react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { LegalTextLink } from "./LegalTextLink";

// The line under a legal summary (#208, ADR-010 §4): the version this app
// carries, as a link to the full text on the website at that version's anchor.

afterEach(() => {
  jest.restoreAllMocks();
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
});

describe("LegalTextLink", () => {
  it.each([
    ["terms", "https://kuutti.app/legal/terms/#terms-"],
    ["privacy", "https://kuutti.app/legal/privacy/#privacy-"],
    ["research", "https://kuutti.app/legal/privacy/#research-"],
    ["special_category", "https://kuutti.app/legal/privacy/#special_category-"],
  ] as const)(
    "opens the full text of %s at the anchor of the version it names",
    async (kind, page) => {
      const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
      const version = CONSENT_VERSIONS[kind];
      await renderWithTheme(<LegalTextLink kind={kind} />);
      const link = screen.getByRole("link", {
        name: `Read the full text on kuutti.app (version ${version})`,
      });
      expect(pressables(screen.toJSON() as HostNode).flatMap((n) => a11yProblems(n))).toEqual([]);
      await fireEvent.press(link);
      expect(open).toHaveBeenCalledWith(`${page}${version}`);
    },
  );

  it.each([
    ["fi-FI", "Lue koko teksti osoitteessa kuutti.app (versio "],
    ["sv-FI", "Läs hela texten på kuutti.app (version "],
  ])("says where it leads in the phone's language, %s", async (languageTag, text) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
    await renderWithTheme(<LegalTextLink kind="privacy" />);
    expect(await screen.findByText(`${text}${CONSENT_VERSIONS.privacy})`)).toBeTruthy();
  });
});
