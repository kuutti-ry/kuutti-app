import { screen } from "@testing-library/react-native";
import { renderWithTheme } from "@/test/render";
import { TechConfigScreen } from "./TechConfigScreen";

// The store's build: the route exists, the view does not, and nothing is fetched.
jest.mock("expo-updates", () => ({ channel: "production" }));

describe("the tech config screen in a production build", () => {
  it("says it is not in this build and reaches for nothing", async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await renderWithTheme(<TechConfigScreen />);
    expect(screen.getByText("Not in this build.")).toBeTruthy();
    expect(screen.queryByText(/^Environment:/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Send a test error" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
