import { PARTY_OPTIONS, PROFILE_FIELDS } from "@kuutti/schema";
import { act, screen } from "@testing-library/react-native";
import type React from "react";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { Chip } from "./FieldEditor";
import { GLYPH_FIELDS, GLYPHLESS_PARTIES, OptionGlyph, optionGlyph } from "./glyphs";

/** The nodes hidden from a screen reader: what a decorative glyph renders as. */
const hidden = (node: HostNode | string | null | undefined): HostNode[] => {
  if (!node || typeof node === "string") return [];
  const own = node.props?.accessibilityElementsHidden === true ? [node] : [];
  return [...own, ...(node.children ?? []).flatMap(hidden)];
};

const show = (ui: React.ReactElement) =>
  act(async () => {
    renderWithTheme(ui);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
  });

describe("the option glyphs (#213)", () => {
  it("exist for every party but the wordmarks, for the religions with a symbol and for every sign, and for nothing else", () => {
    for (const party of PARTY_OPTIONS) {
      expect([party, optionGlyph("politics", party) !== null]).toEqual([
        party,
        !GLYPHLESS_PARTIES.includes(party),
      ]);
    }
    expect(optionGlyph("politics", "none_of_them")).toBeNull();
    expect(optionGlyph("politics", "kahvipuolue")).toBeNull();
    for (const sign of PROFILE_FIELDS.zodiac.options)
      expect(optionGlyph("zodiac", sign)).not.toBeNull();
    const symbols = [
      "lutheran",
      "orthodox",
      "other_christian",
      "muslim",
      "buddhist",
      "hindu",
      "jewish",
    ];
    for (const option of PROFILE_FIELDS.religion.options) {
      expect([option, optionGlyph("religion", option) !== null]).toEqual([
        option,
        symbols.includes(option),
      ]);
    }
    expect(optionGlyph("intent", "long_term")).toBeNull();
    expect(GLYPH_FIELDS).toEqual(["politics", "religion", "zodiac"]);
  });

  it("is decorative in a chip: the name is the button's label and the only thing a screen reader meets", async () => {
    const onPress = jest.fn();
    await show(
      <Chip
        label="Corgi"
        selected={false}
        onPress={onPress}
        glyph={<OptionGlyph field="zodiac" option="corgi" />}
      />,
    );
    const button = screen.getByRole("button", { name: "Corgi" });
    expect(button).toBeTruthy();
    expect(screen.queryByRole("image")).toBeNull();
    expect(hidden(screen.toJSON() as HostNode)).toHaveLength(1);
    expect(pressables(screen.toJSON() as HostNode).flatMap(a11yProblems)).toEqual([]);
  });

  it("is nothing for an option without one, so the chip stays plain text", async () => {
    await show(<OptionGlyph field="politics" option="none_of_them" />);
    expect(hidden(screen.toJSON() as HostNode)).toEqual([]);
  });
});
