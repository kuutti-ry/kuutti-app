import { act, screen, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import { saveSession } from "@/lib/session";
import { renderWithTheme } from "@/test/render";
import { useOnboardingGate } from "./useOnboardingGate";

// The home screen's gate reads the status when the screen is shown and again
// whenever it regains the focus: a consent withdrawn in Settings reopens a
// step, and coming back to home is when the person is sent to it.

const { __router: router, __focus: focus } = jest.requireMock("expo-router") as {
  __router: { replace: jest.Mock };
  __focus: () => void;
};
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);

const POND = {
  id: "0b4f3a0e-7c2f-4e2b-9a9a-1a2b3c4d5e6f",
  slug: "paakaupunkiseutu",
  name: "Pääkaupunkiseutu",
  nameInessive: "Pääkaupunkiseudulla",
  parentId: null,
};
const VERSION = "2026-09-draft-1";
const status = (missing: string[]) => ({
  state: "active",
  age: 56,
  gender: "man",
  pond: POND,
  preferences: {
    seeks: missing.includes("seeks") ? null : ["woman"],
    ageWindow: { min: 51, max: 61 },
  },
  consents: {
    terms: VERSION,
    privacy: VERSION,
    specialCategory: missing.includes("seeks") ? null : "2026-10-draft-2",
    research: null,
  },
  currentVersions: {
    terms: VERSION,
    privacy: VERSION,
    research: VERSION,
    special_category: "2026-10-draft-2",
  },
  nextChange: { gender: null, seeks: null },
  missing,
  complete: missing.length === 0,
});

let missing: string[] = [];
let reads = 0;

function Probe() {
  const gate = useOnboardingGate();
  return <Text>{gate.status}</Text>;
}

beforeEach(async () => {
  router.replace.mockReset();
  missing = [];
  reads = 0;
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
  globalThis.fetch = jest.fn(async (input: Request | string) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/onboarding") {
      reads += 1;
      return json(status(missing));
    }
    return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
  }) as unknown as typeof fetch;
});

describe("the home screen's onboarding gate", () => {
  it("reads the status again when the screen regains the focus, and sends a reopened step to onboarding", async () => {
    await act(async () => {
      renderWithTheme(<Probe />);
      await settle();
    });
    await waitFor(() => expect(screen.getByText("complete")).toBeTruthy());
    expect(reads).toBe(1);
    expect(router.replace).not.toHaveBeenCalled();

    // The special-category consent is withdrawn in Settings; the seek answer went with it.
    missing = ["seeks"];
    await act(async () => {
      focus();
      await settle();
    });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/onboarding"));
    expect(reads).toBe(2);
  });

  it("keeps what it knew on screen while a re-read is in flight", async () => {
    await act(async () => {
      renderWithTheme(<Probe />);
      await settle();
    });
    await waitFor(() => expect(screen.getByText("complete")).toBeTruthy());
    await act(async () => {
      focus();
    });
    // No "checking" flash between two complete readings.
    expect(screen.getByText("complete")).toBeTruthy();
    await act(async () => {
      await settle();
    });
    expect(screen.getByText("complete")).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
