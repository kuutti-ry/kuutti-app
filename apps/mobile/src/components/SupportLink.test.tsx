import { act, fireEvent, screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { SupportLink } from "./SupportLink";

// The way to the support page where somebody may be left low (#510).

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock };
};

const press = (name: string) =>
  act(async () => {
    fireEvent.press(screen.getByRole("link", { name }));
  });

beforeEach(() => {
  router.push.mockReset();
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en" }]);
});

describe("SupportLink (#510)", () => {
  it.each([
    ["en", "Support when it's hard"],
    ["fi", "Tukea, kun on vaikeaa"],
    ["sv", "Stöd när det är svårt"],
  ])("goes to the support page, named as the page is, in %s", async (languageTag, name) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
    await renderWithTheme(<SupportLink />);
    expect(screen.getByText(name)).toBeTruthy();
    await press(name);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith("/settings/support");
  });

  it("lets a dialog close before it goes", async () => {
    const order: string[] = [];
    router.push.mockImplementation(() => order.push("went"));
    await renderWithTheme(<SupportLink onLeave={() => order.push("left")} />);
    await press("Support when it's hard");
    expect(order).toEqual(["left", "went"]);
  });

  it("is a named link, big enough, its picture silent", async () => {
    await renderWithTheme(<SupportLink />);
    const controls = pressables(screen.toJSON() as HostNode);
    expect(controls).toHaveLength(1);
    expect(controls.flatMap((node) => a11yProblems(node))).toEqual([]);
  });
});
