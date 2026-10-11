import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { renderWithTheme } from "@/test/render";
import { TechConfigScreen } from "./TechConfigScreen";

// A dev client on Metro that runs the build's own bundle: no update channel,
// no runtime and no commit recorded, and app.json's version the only one
// (the screen reads all of it at render time).
jest.mock("expo-updates", () => ({
  channel: null,
  runtimeVersion: null,
  isEmbeddedLaunch: true,
  createdAt: null,
}));
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { expoConfig: { version: "1.2.3", extra: {} } },
}));

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { back: jest.Mock };
};

beforeEach(() => router.back.mockReset());

describe("the tech config screen of a build's own bundle", () => {
  it("says what it does not know rather than leaving lines out", async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch;
    await renderWithTheme(<TechConfigScreen />);
    await waitFor(() => expect(screen.getByText("API unreachable")).toBeTruthy());
    expect(screen.getByText("Environment: development")).toBeTruthy();
    expect(screen.getByText("git commit not recorded in this build")).toBeTruthy();
    expect(screen.getByText("native build not recorded")).toBeTruthy();
    expect(screen.getByText("running the build's own bundle, no update applied yet")).toBeTruthy();
    expect(screen.getByText("channel ")).toBeTruthy();
    expect(screen.getByText("version 1.2.3")).toBeTruthy();
  });

  it("shows whatever the request failed with, even when it is not an Error", async () => {
    globalThis.fetch = jest.fn(() => Promise.reject("socket closed")) as unknown as typeof fetch;
    await renderWithTheme(<TechConfigScreen />);
    await waitFor(() => expect(screen.getByText("socket closed")).toBeTruthy());
  });

  it("goes back with its back button", async () => {
    globalThis.fetch = jest.fn(
      () => new Promise<Response>(() => undefined),
    ) as unknown as typeof fetch;
    await renderWithTheme(<TechConfigScreen />);
    await fireEvent.press(screen.getByRole("button", { name: "Back" }));
    expect(router.back).toHaveBeenCalledTimes(1);
  });
});
