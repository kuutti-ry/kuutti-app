import { act, fireEvent, screen } from "@testing-library/react-native";
import Sun from "lucide-react-native/icons/sun";
import { Platform, Text } from "react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import { type Row, RowGroup } from "./RowGroup";

// The rows of a list (#227, #287): a row that opens a screen is a button named
// by its title, with the summary as the hint and the state as the value; a
// row with nothing to open is read with its detail.

describe("RowGroup", () => {
  it("makes a button of a row that opens, with its words where a screen reader expects them", async () => {
    const open = jest.fn();
    await renderWithTheme(
      <RowGroup
        rows={[
          {
            key: "a",
            title: "The basics",
            summary: "Name and height",
            value: "2 of 5 answered",
            mark: <Text>mark</Text>,
            onPress: open,
          },
          { key: "b", title: "Prompts", onPress: () => {} },
          { key: "c", title: "Theme", summary: "Dark", value: "Dark", onPress: () => {} },
        ]}
      />,
    );
    const basics = screen.getByRole("button", { name: "The basics" });
    expect(basics.props.accessibilityHint).toBe("Name and height");
    expect(basics.props.accessibilityValue).toEqual({ text: "2 of 5 answered" });
    expect(screen.getByText("mark")).toBeTruthy();
    const prompts = screen.getByRole("button", { name: "Prompts" });
    expect(prompts.props.accessibilityHint).toBeUndefined();
    expect(prompts.props.accessibilityValue?.text).toBeUndefined();
    // A summary that is the state is said once, as the value.
    const theme = screen.getByRole("button", { name: "Theme" });
    expect(theme.props.accessibilityValue).toEqual({ text: "Dark" });
    expect(theme.props.accessibilityHint).toBeUndefined();
    // Only a hairline under each row but the last, not the Button's own
    // border on every side (#467).
    for (const row of [basics, prompts]) {
      expect(row.props.className).toMatch(/\bborder-0\b.*\bborder-b border-border\b/);
      expect(row.props.className).not.toMatch(/(^| )border( |$)/);
    }
    expect(theme.props.className).toMatch(/\bborder-0\b/);
    expect(theme.props.className).not.toMatch(/(^| )border(-b)?( |$)/);
    await fireEvent.press(basics);
    expect(open).toHaveBeenCalledTimes(1);
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
  });

  describe("a row that holds its panel (#511)", () => {
    const toggle = jest.fn();
    const rows = (expanded: boolean, extra: Partial<Row> = {}): Row[] => [
      {
        key: "theme",
        title: "Theme",
        summary: "Dark",
        value: "Dark",
        panel: <Text>the choices</Text>,
        expanded,
        onPress: toggle,
        ...extra,
      },
      { key: "licences", title: "Licences", onPress: () => {} },
    ];
    const theme = () => screen.getByRole("button", { name: "Theme" });
    beforeEach(() => toggle.mockReset());
    afterEach(() => jest.restoreAllMocks());

    it("opens under itself, with the hairline under the panel, not between them", async () => {
      const view = await renderWithTheme(<RowGroup rows={rows(false)} />);
      expect(screen.queryByText("the choices")).toBeNull();
      await fireEvent.press(theme());
      expect(toggle).toHaveBeenCalledTimes(1);
      await view.rerender(underProviders(<RowGroup rows={rows(true)} />));
      expect(screen.getByText("the choices")).toBeTruthy();
      expect(theme().props.className).not.toMatch(/\bborder-b\b/);
      expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
        [],
      );
    });

    it("on iOS says its state in words after its value, since iOS says no collapsed", async () => {
      jest.replaceProperty(Platform, "OS", "ios");
      const view = await renderWithTheme(<RowGroup rows={rows(false)} />);
      expect(theme().props.accessibilityValue).toEqual({ text: "Dark, closed" });
      expect(theme().props.accessibilityState?.expanded).toBeUndefined();
      await view.rerender(underProviders(<RowGroup rows={rows(true, { value: undefined })} />));
      expect(theme().props.accessibilityValue).toEqual({ text: "open" });
      // A row that opens a screen says nothing of open or closed.
      expect(
        screen.getByRole("button", { name: "Licences" }).props.accessibilityValue?.text,
      ).toBeUndefined();
    });

    it("on Android is heard as expanded or collapsed, and TalkBack's action opens it", async () => {
      jest.replaceProperty(Platform, "OS", "android");
      await renderWithTheme(<RowGroup rows={rows(false)} />);
      expect(theme().props.accessibilityState).toMatchObject({ expanded: false });
      expect(theme().props.accessibilityValue).toEqual({ text: "Dark" });
      expect(theme().props.accessibilityActions).toEqual([{ name: "expand", label: "Theme" }]);
      await fireEvent(theme(), "accessibilityAction", { nativeEvent: { actionName: "expand" } });
      expect(toggle).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("button", { name: "Licences" }).props.accessibilityActions,
      ).toBeUndefined();
    });

    it("keeps a panel once opened mounted while closed, out of sight and of a screen reader's reach", async () => {
      await renderWithTheme(<RowGroup rows={rows(false, { kept: true })} />);
      expect(screen.queryByText("the choices")).toBeNull();
      const hidden = screen.getByText("the choices", { includeHiddenElements: true });
      let wrapper = hidden.parent;
      while (wrapper && wrapper.props.importantForAccessibility === undefined)
        wrapper = wrapper.parent;
      expect(wrapper?.props).toMatchObject({
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants",
      });
      expect(wrapper?.props.className).toMatch(/\bhidden\b/);
    });

    it("tells once for each opening, a frame after its panel is drawn", async () => {
      const opened = jest.fn();
      const frame = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
      const view = await renderWithTheme(<RowGroup rows={rows(true, { onOpened: opened })} />);
      await frame();
      expect(opened).toHaveBeenCalledTimes(1);
      expect(opened.mock.calls[0]?.[0]).toEqual({
        wrapper: expect.anything(),
        header: expect.anything(),
      });
      // Drawn again while open, it tells nothing more.
      await view.rerender(underProviders(<RowGroup rows={rows(true, { onOpened: opened })} />));
      await frame();
      expect(opened).toHaveBeenCalledTimes(1);
      await view.rerender(
        underProviders(<RowGroup rows={rows(false, { onOpened: opened, kept: true })} />),
      );
      await frame();
      await view.rerender(
        underProviders(<RowGroup rows={rows(true, { onOpened: opened, kept: true })} />),
      );
      await frame();
      expect(opened).toHaveBeenCalledTimes(2);
    });

    it("never lets its wrapper be flattened away, which would measure as its header alone", async () => {
      await renderWithTheme(<RowGroup rows={rows(true)} />);
      let node = screen.getByText("the choices").parent;
      while (node && node.props.collapsable === undefined) node = node.parent;
      expect(node?.props.collapsable).toBe(false);
    });

    it("draws a picture before the title, silent, and sets it and the chevron by the first line", async () => {
      await renderWithTheme(<RowGroup rows={rows(false, { icon: Sun })} />);
      expect(theme().props.className).toMatch(/\bitems-start\b/);
      expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
        [],
      );
    });
  });

  it("reads a row with nothing to open, its detail as the value", async () => {
    await renderWithTheme(
      <RowGroup
        rows={[{ key: "v", title: "Version", summary: "Build abc1234", detail: "0.19.0" }]}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    const version = screen.getByLabelText("Version");
    expect(version.props.accessibilityValue).toEqual({ text: "0.19.0, Build abc1234" });
    expect(screen.getByText("0.19.0")).toBeTruthy();
    expect(screen.getByText("Build abc1234")).toBeTruthy();
  });

  it("reads a plain row with only a summary, or with nothing beside its title", async () => {
    await renderWithTheme(
      <RowGroup
        rows={[
          { key: "a", title: "Built", summary: "abc1234" },
          { key: "b", title: "Bare" },
        ]}
      />,
    );
    expect(screen.getByLabelText("Built").props.accessibilityValue).toEqual({ text: "abc1234" });
    expect(screen.getByLabelText("Bare").props.accessibilityValue).toBeUndefined();
  });
});
