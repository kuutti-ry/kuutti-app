import { fireEvent, screen } from "@testing-library/react-native";
import { Linking } from "react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { SourceOffer } from "./SourceOffer";

// The source-code offer of AGPL-3.0 section 13 (#16): the address as text and
// as a labelled link that opens it outside the app.

const SOURCE = "https://codeberg.org/example/kuutti-fork";

afterEach(() => jest.restoreAllMocks());

describe("SourceOffer", () => {
  it("says what the source is and shows its address as text, its screen carrying the title", async () => {
    await renderWithTheme(<SourceOffer source={SOURCE} />);
    expect(screen.queryByRole("header")).toBeNull();
    expect(
      screen.getByText("Kuutti is free software under the AGPL-3.0 licence, published at:"),
    ).toBeTruthy();
    expect(screen.getByText(SOURCE)).toBeTruthy();
    expect(pressables(screen.toJSON() as HostNode).flatMap((n) => a11yProblems(n))).toEqual([]);
  });

  it("opens the address in the browser from a labelled link", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await renderWithTheme(<SourceOffer source={SOURCE} />);
    await fireEvent.press(
      screen.getByRole("link", { name: "Open the source code in the browser" }),
    );
    expect(open).toHaveBeenCalledWith(SOURCE);
  });
});
