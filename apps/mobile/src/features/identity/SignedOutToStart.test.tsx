import { act } from "@testing-library/react-native";
import { clearSession, saveSession } from "@/lib/session";
import { renderWithTheme } from "@/test/render";
import { SignedOutToStart } from "./SignedOutToStart";

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { replace: jest.Mock };
};

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

beforeEach(async () => {
  router.replace.mockReset();
  await clearSession();
});

describe("SignedOutToStart", () => {
  it("takes the app to the start when the session ends while a screen is open", async () => {
    await saveSession({
      sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
      accessToken: token("access"),
      accessExpiresAt: "2030-01-01T00:15:00.000Z",
      refreshToken: token("refresh"),
      refreshExpiresAt: "2030-04-01T00:00:00.000Z",
    });
    await act(async () => {
      renderWithTheme(<SignedOutToStart />);
      await settle();
    });
    expect(router.replace).not.toHaveBeenCalled();
    // What a refused refresh does: the store is cleared (src/lib/session.ts).
    await act(async () => {
      await clearSession();
      await settle();
    });
    expect(router.replace).toHaveBeenCalledWith("/");
  });

  it("leaves a start without a session where it is", async () => {
    await act(async () => {
      renderWithTheme(<SignedOutToStart />);
      await settle();
    });
    expect(router.replace).not.toHaveBeenCalled();
  });
});
