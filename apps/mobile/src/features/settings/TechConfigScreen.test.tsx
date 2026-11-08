import * as Sentry from "@sentry/react-native";
import { fireEvent, screen, userEvent, waitFor, within } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { Linking } from "react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { TechConfigScreen } from "./TechConfigScreen";

// A staging build that runs an over-the-air update, with a commit stamped
// into the config: the screen reads both at render time.
jest.mock("expo-updates", () => ({
  channel: "staging",
  runtimeVersion: "88a4337f0053b4dd4b1b1f9560daf6ddf0fcf68d",
  isEmbeddedLaunch: false,
  createdAt: new Date("2026-09-26T17:35:00.000Z"),
}));
jest.mock("expo-constants", () => ({
  __esModule: true,
  // app.json's 1.2.3 is the store's; the counted version rides in extra and is what the screen names (#172).
  default: { expoConfig: { version: "1.2.3", extra: { commit: "1a2b3c4", version: "0.1.0" } } },
}));

const ok = {
  status: "ok",
  version: "0.0.0-test",
  commit: "abc1234",
  builtAt: "2026-09-13T00:00:00.000Z",
  source: "https://github.com/kuutti-ry/kuutti-app",
  db: "ok",
  migrations: "current",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the tech config screen", () => {
  beforeEach(() => {
    globalThis.fetch = jest.fn(async () => json(ok)) as unknown as typeof fetch;
    (Sentry.captureException as jest.Mock).mockClear();
  });
  afterEach(() => jest.restoreAllMocks());

  // The designers' try, on this screen alone, which production has not: a
  // style and a palette, each a group of radios that says and keeps its choice.
  it.each([
    ["Style to try", ["Today's", "Neubrutalism"], "Neubrutalism", "look", "neubrutalism"],
    ["Colours to try", ["Today's", "Ice", "Dusk", "Birch"], "Dusk", "palette", "dusk"],
  ] as const)(
    "offers the try's %s as radios, today's first, and keeps the one chosen",
    async (title, options, pick, key, stored) => {
      const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
      store.clear();
      await renderWithTheme(<TechConfigScreen />);
      await waitFor(() => expect(screen.getByText("git commit abc1234")).toBeTruthy());
      const group = screen.getByLabelText(title);
      expect(group.props.accessibilityRole).toBe("radiogroup");
      const labels = () =>
        within(group)
          .getAllByRole("radio")
          .map((radio) => radio.props.accessibilityLabel);
      expect(labels()).toEqual(options.map((option, at) => (at === 0 ? `✓ ${option}` : option)));
      await fireEvent.press(within(group).getByRole("radio", { name: pick }));
      expect(labels()).toEqual(options.map((option) => (option === pick ? `✓ ${option}` : option)));
      await waitFor(() => expect(store.get(`kuutti.preference.${key}`)).toBe(stored));
      expect(pressables(screen.toJSON() as HostNode).flatMap((n) => a11yProblems(n))).toEqual([]);
    },
  );

  it("keeps the title and the way back pinned above the details", async () => {
    await renderWithTheme(<TechConfigScreen />);
    await waitFor(() => expect(screen.getByText("git commit abc1234")).toBeTruthy());
    expectPinnedHeader("Tech config", "Back");
  });

  it("names the environment, the API with its commit and database, and the app apart from it", async () => {
    await renderWithTheme(<TechConfigScreen />);
    await waitFor(() => expect(screen.getByText("git commit abc1234")).toBeTruthy());
    expect(screen.getByText("Environment: staging")).toBeTruthy();
    expect(screen.getByText("database ok · migrations current")).toBeTruthy();
    expect(screen.getByText("git commit 1a2b3c4")).toBeTruthy();
    expect(screen.getByText("native build 88a4337")).toBeTruthy();
    expect(screen.getByText(/^update published /)).toBeTruthy();
    expect(screen.getByText("channel staging")).toBeTruthy();
    expect(screen.getByText("version 0.1.0")).toBeTruthy();
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
  });

  it("names the version without a releases link, and offers the source of the running service", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await renderWithTheme(<TechConfigScreen />);
    await waitFor(() => expect(screen.getByText("git commit abc1234")).toBeTruthy());
    expect(screen.getByText("version 0.1.0")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Releases on GitHub" })).toBeNull();
    expect(screen.getByRole("header", { name: "Source code" })).toBeTruthy();
    const user = userEvent.setup();
    await user.press(screen.getByRole("link", { name: "https://github.com/kuutti-ry/kuutti-app" }));
    expect(open.mock.calls.map((c) => c[0])).toEqual(["https://github.com/kuutti-ry/kuutti-app"]);
  });

  it("says in words when the API is unreachable, and checks again on request", async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await renderWithTheme(<TechConfigScreen />);
    await waitFor(() => expect(screen.getByText("API unreachable")).toBeTruthy());
    expect(screen.getByText("ECONNREFUSED")).toBeTruthy();
    globalThis.fetch = jest.fn(async () => json(ok)) as unknown as typeof fetch;
    fireEvent.press(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.getByText("git commit abc1234")).toBeTruthy());
  });

  it("sends one marked test error and says so", async () => {
    await renderWithTheme(<TechConfigScreen />);
    await screen.findByText("git commit abc1234");
    await userEvent.setup().press(screen.getByRole("button", { name: "Send a test error" }));
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect((Sentry.captureException as jest.Mock).mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(screen.getByText(/^Test error sent\./)).toBeTruthy();
  });
});
