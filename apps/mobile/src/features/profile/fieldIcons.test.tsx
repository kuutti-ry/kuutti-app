import { PROFILE_FIELD_KEYS } from "@kuutti/schema";
import { screen } from "@testing-library/react-native";
import { renderWithTheme } from "@/test/render";
import { FIELD_ICONS, FieldLabel } from "./fieldIcons";

// An icon before every field's label (#239): placeholders until the designer draws the set.

const hidden = { includeHiddenElements: true };

describe("FIELD_ICONS", () => {
  it("gives every field of the registry an icon, and names no other", () => {
    expect(Object.keys(FIELD_ICONS).sort()).toEqual([...PROFILE_FIELD_KEYS].sort());
    for (const key of PROFILE_FIELD_KEYS) expect(FIELD_ICONS[key]).toBeTruthy();
  });

  it("gives each field an icon of its own", () => {
    const icons = Object.values(FIELD_ICONS);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe("FieldLabel", () => {
  it("names the field in words, with its icon before the name and hidden from screen readers", async () => {
    await renderWithTheme(<FieldLabel field="drinking" />);
    expect(screen.getByText("Drinking")).toBeTruthy();
    expect(screen.getByTestId("field-icon-drinking", hidden)).toBeTruthy();
    expect(screen.queryByTestId("field-icon-drinking")).toBeNull();
  });

  it.each([
    ["nicotine", "Other nicotine"],
    ["religion", "Religion"],
  ] as const)(
    "draws the %s icon in Lucide's grid and line, in the text colour",
    async (field, label) => {
      await renderWithTheme(<FieldLabel field={field} />);
      expect(screen.getByText(label)).toBeTruthy();
      const svg = screen.getByTestId(`field-icon-${field}`, hidden);
      // The stroke is currentColor, as Lucide's own: the shapes take the text colour.
      expect(svg.props).toMatchObject({
        width: 16,
        height: 16,
        vbWidth: 24,
        vbHeight: 24,
        stroke: "currentColor",
      });
      expect(JSON.stringify(screen.toJSON())).toContain('"strokeWidth":2');
    },
  );
});

describe("the icons drawn here", () => {
  it.each(["nicotine", "religion"] as const)(
    "take Lucide's defaults for %s, and what they are given instead",
    async (field) => {
      const Drawn = FIELD_ICONS[field];
      await renderWithTheme(<Drawn testID="plain" />);
      expect(screen.getByTestId("plain").props).toMatchObject({
        width: 24,
        height: 24,
        stroke: "currentColor",
      });
      expect(JSON.stringify(screen.toJSON())).toContain('"strokeWidth":2');
      await renderWithTheme(<Drawn testID="given" size={32} color="red" strokeWidth={3} />);
      expect(screen.getByTestId("given").props).toMatchObject({
        width: 32,
        height: 32,
        stroke: "red",
      });
      expect(JSON.stringify(screen.toJSON())).toContain('"strokeWidth":3');
    },
  );
});
