import { act, fireEvent, screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { AccessibilityInfo, Platform } from "react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import type { BiometricAnswer, Biometrics } from "./biometrics";
import { LockScreen, type PasscodeAnswer } from "./LockScreen";

// The lock over the app (#418, ADR-045): the phone's face or fingerprint,
// asked once as it shows and again on the button; the passcode, a wrong one
// said in words with the tries left; and the bank, always there.

const FIELD = "Your Kuutti passcode";
const BANK = "Sign in with the bank instead";
const FAILED = "Your face did not unlock Kuutti. Try again, or use another way below.";
/** The way back from the phone's pause, the same for every kind. */
const PAUSED_UNTIL =
  "Lock the phone and open it with its own code, then try again, or use another way below.";
/** A refusal in the words of the kind the button names (#464). */
const REFUSAL = {
  failed: {
    face: FAILED,
    fingerprint: "Your fingerprint did not unlock Kuutti. Try again, or use another way below.",
    either: "Your face or fingerprint did not unlock Kuutti. Try again, or use another way below.",
  },
  lockout: {
    face: `The phone has paused face unlock after too many tries. ${PAUSED_UNTIL}`,
    fingerprint: `The phone has paused fingerprint unlock after too many tries. ${PAUSED_UNTIL}`,
    either: `The phone has paused face or fingerprint unlock after too many tries. ${PAUSED_UNTIL}`,
  },
} as const;
const DENIED =
  "This iPhone does not let Kuutti use Face ID. You can allow it in the phone's settings, or use another way below.";
const UNLOCK = {
  face: "Unlock with your face",
  fingerprint: "Unlock with your fingerprint",
  either: "Unlock with your face or fingerprint",
} as const;

const announced = () =>
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mock.calls.map(([words]) => words);
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);
const field = () => screen.getByLabelText(FIELD);
const button = (name: string) => screen.getByRole("button", { name });

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Props = {
  biometrics: Biometrics | null;
  denied: boolean;
  passcode: boolean;
  onBiometrics: jest.Mock<Promise<BiometricAnswer>, []>;
  onPasscode: jest.Mock<Promise<PasscodeAnswer>, [string]>;
  onBank: jest.Mock;
};

/** The lock screen with the given ways in; by default the passcode alone, every answer "no". */
async function show(over: Partial<Props> = {}) {
  const props: Props = {
    biometrics: null,
    denied: false,
    passcode: true,
    onBiometrics: jest.fn(async (): Promise<BiometricAnswer> => "cancelled"),
    onPasscode: jest.fn(async (_code: string): Promise<PasscodeAnswer> => ({ ok: false, left: 4 })),
    onBank: jest.fn(),
    ...over,
  };
  const view = await renderWithTheme(<LockScreen {...props} />);
  // The first ask, when there is one, has answered.
  await act(async () => undefined);
  return { ...props, view, props };
}

/** Types a whole code into the field and lets its answer arrive. */
async function typeCode(code: string) {
  await fireEvent.changeText(field(), code);
  await act(async () => undefined);
}

beforeEach(() => {
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
});
afterEach(() => jest.restoreAllMocks());

describe("LockScreen", () => {
  it("says Kuutti is locked, with the passcode and the bank, and no accessibility problems", async () => {
    await show();
    expect(screen.getByRole("heading", { name: "Kuutti is locked" })).toBeTruthy();
    expect(field()).toBeTruthy();
    expect(button(BANK)).toBeTruthy();
    expect(screen.getByText(/signs Kuutti out of this phone and turns the lock off/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Unlock with/ })).toBeNull();
    noProblems();
  });

  it.each([
    ["face", "Unlock with your face"],
    ["fingerprint", "Unlock with your fingerprint"],
    ["either", "Unlock with your face or fingerprint"],
  ] as const)("names the phone's %s on its button", async (biometrics, name) => {
    await show({ biometrics });
    expect(button(name)).toBeTruthy();
    noProblems();
  });

  it("offers the face alone, with no passcode field, and the bank", async () => {
    await show({ biometrics: "face", passcode: false });
    expect(screen.queryByLabelText(FIELD)).toBeNull();
    expect(button("Unlock with your face")).toBeTruthy();
    expect(button(BANK)).toBeTruthy();
    noProblems();
  });

  it("keeps the bank as the only way out when it has neither way in", async () => {
    await show({ passcode: false });
    expect(screen.queryByLabelText(FIELD)).toBeNull();
    const found = pressables(screen.toJSON() as HostNode);
    expect(found).toHaveLength(1);
    expect(button(BANK)).toBeTruthy();
  });

  it("puts the focus in the field when there is no face or fingerprint to ask", async () => {
    await show();
    expect(field().props.autoFocus).toBe(true);
  });

  it("leaves the focus to the phone's prompt when it asks for the face first", async () => {
    await show({ biometrics: "face" });
    expect(field().props.autoFocus).toBe(false);
  });

  describe("the face or fingerprint", () => {
    it("is asked once as the lock shows, and not again on a new render", async () => {
      const { onBiometrics, view, props } = await show({ biometrics: "face" });
      expect(onBiometrics).toHaveBeenCalledTimes(1);
      await view.rerender(underProviders(<LockScreen {...props} biometrics="either" />));
      await act(async () => undefined);
      expect(onBiometrics).toHaveBeenCalledTimes(1);
    });

    it("is never asked when the person did not choose it", async () => {
      const { onBiometrics } = await show();
      expect(onBiometrics).not.toHaveBeenCalled();
    });

    it("is asked as soon as the phone's kind is known, when that comes after the lock showed", async () => {
      const { onBiometrics, view, props } = await show({ biometrics: null });
      expect(onBiometrics).not.toHaveBeenCalled();
      await view.rerender(underProviders(<LockScreen {...props} biometrics="fingerprint" />));
      await act(async () => undefined);
      expect(onBiometrics).toHaveBeenCalledTimes(1);
      expect(button("Unlock with your fingerprint")).toBeTruthy();
    });

    it("is asked again on the button", async () => {
      const { onBiometrics } = await show({ biometrics: "face" });
      await fireEvent.press(button("Unlock with your face"));
      await act(async () => undefined);
      expect(onBiometrics).toHaveBeenCalledTimes(2);
    });

    it("says so, aloud on iOS, when the face or finger did not unlock it", async () => {
      jest.replaceProperty(Platform, "OS", "ios");
      const onBiometrics = jest.fn(async (): Promise<BiometricAnswer> => "failed");
      await show({ biometrics: "face", onBiometrics });
      const notice = screen.getByText(FAILED);
      expect(notice.props.accessibilityLiveRegion).toBe("assertive");
      expect(announced()).toEqual([FAILED]);
    });

    it.each(["failed", "lockout"] as const)(
      "leaves the announcing of %s to the live region on Android",
      async (answer) => {
        jest.replaceProperty(Platform, "OS", "android");
        const onBiometrics = jest.fn(async (): Promise<BiometricAnswer> => answer);
        await show({ biometrics: "face", onBiometrics });
        expect(screen.getByText(REFUSAL[answer].face).props.accessibilityLiveRegion).toBe(
          "assertive",
        );
        expect(announced()).toEqual([]);
      },
    );

    it.each(["cancelled", "ok"] as const)(
      "says nothing when the prompt answers %s",
      async (answer) => {
        jest.replaceProperty(Platform, "OS", "ios");
        const onBiometrics = jest.fn(async (): Promise<BiometricAnswer> => answer);
        await show({ biometrics: "face", onBiometrics });
        expect(screen.queryByText(REFUSAL.failed.face)).toBeNull();
        expect(screen.queryByText(REFUSAL.lockout.face)).toBeNull();
        expect(announced()).toEqual([]);
      },
    );

    it.each(["face", "fingerprint", "either"] as const)(
      "says a failure of the phone's %s in the words its button names",
      async (kind) => {
        const onBiometrics = jest.fn(async (): Promise<BiometricAnswer> => "failed");
        await show({ biometrics: kind, onBiometrics });
        expect(button(UNLOCK[kind])).toBeTruthy();
        expect(screen.getByText(REFUSAL.failed[kind])).toBeTruthy();
        for (const other of ["face", "fingerprint", "either"] as const) {
          if (other !== kind) expect(screen.queryByText(REFUSAL.failed[other])).toBeNull();
        }
      },
    );

    // Android pauses after about five wrong fingers, for 30 seconds or until
    // the phone's own code; iOS until that code. No prompt shows meanwhile.
    it.each(["face", "fingerprint", "either"] as const)(
      "says the phone's pause of its %s and how it ends, aloud on iOS, never a failure",
      async (kind) => {
        jest.replaceProperty(Platform, "OS", "ios");
        const onBiometrics = jest.fn(async (): Promise<BiometricAnswer> => "lockout");
        await show({ biometrics: kind, onBiometrics });
        const notice = screen.getByText(REFUSAL.lockout[kind]);
        expect(notice.props.accessibilityLiveRegion).toBe("assertive");
        expect(announced()).toEqual([REFUSAL.lockout[kind]]);
        expect(screen.queryByText(/did not unlock/)).toBeNull();
        // The button stays for after the pause, and the other ways in are there.
        expect(button(UNLOCK[kind])).toBeEnabled();
        expect(field()).toBeTruthy();
        expect(button(BANK)).toBeEnabled();
        noProblems();
      },
    );

    it("says the pause again in a fresh live region when the button is pressed during it", async () => {
      const onBiometrics = jest.fn(async (): Promise<BiometricAnswer> => "lockout");
      await show({ biometrics: "fingerprint", onBiometrics });
      const first = screen.getByText(REFUSAL.lockout.fingerprint);
      await fireEvent.press(button(UNLOCK.fingerprint));
      await act(async () => undefined);
      expect(onBiometrics).toHaveBeenCalledTimes(2);
      expect(screen.getByText(REFUSAL.lockout.fingerprint)).not.toBe(first);
    });

    it("trades a failure for the pause when the phone pauses on a later try, and takes it back on a yes", async () => {
      const onBiometrics = jest
        .fn<Promise<BiometricAnswer>, []>()
        .mockResolvedValueOnce("failed")
        .mockResolvedValueOnce("lockout")
        .mockResolvedValueOnce("ok");
      await show({ biometrics: "face", onBiometrics });
      expect(screen.getByText(REFUSAL.failed.face)).toBeTruthy();
      await fireEvent.press(button(UNLOCK.face));
      await act(async () => undefined);
      expect(screen.queryByText(REFUSAL.failed.face)).toBeNull();
      expect(screen.getByText(REFUSAL.lockout.face)).toBeTruthy();
      await fireEvent.press(button(UNLOCK.face));
      await act(async () => undefined);
      expect(screen.queryByText(REFUSAL.lockout.face)).toBeNull();
    });

    it("speaks the person's language, in the agreement of the kind", async () => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: "fi-FI" }]);
      const onBiometrics = jest
        .fn<Promise<BiometricAnswer>, []>()
        .mockResolvedValueOnce("failed")
        .mockResolvedValueOnce("lockout");
      await show({ biometrics: "fingerprint", onBiometrics });
      expect(
        screen.getByText(
          "Sormenjälkesi ei avannut Kuuttia. Yritä uudelleen tai käytä toista alla olevaa tapaa.",
        ),
      ).toBeTruthy();
      await fireEvent.press(button("Avaa sormenjäljelläsi"));
      await act(async () => undefined);
      expect(
        screen.getByText(/^Puhelin on keskeyttänyt sormenjäljentunnistuksen liian monen/),
      ).toBeTruthy();
    });

    it("says a second failure in a fresh live region, so Android says it again", async () => {
      const onBiometrics = jest.fn(async (): Promise<BiometricAnswer> => "failed");
      await show({ biometrics: "face", onBiometrics });
      const first = screen.getByText(FAILED);
      await fireEvent.press(button("Unlock with your face"));
      await act(async () => undefined);
      expect(onBiometrics).toHaveBeenCalledTimes(2);
      // The same words, in a new element: a region that only changed would stay silent.
      expect(screen.getByText(FAILED)).not.toBe(first);
    });

    it("takes the failure back when a later ask is cancelled", async () => {
      const onBiometrics = jest
        .fn<Promise<BiometricAnswer>, []>()
        .mockResolvedValueOnce("failed")
        .mockResolvedValueOnce("cancelled");
      await show({ biometrics: "face", onBiometrics });
      expect(screen.getByText(FAILED)).toBeTruthy();
      await fireEvent.press(button("Unlock with your face"));
      await act(async () => undefined);
      expect(screen.queryByText(FAILED)).toBeNull();
    });

    it("holds every way in while the prompt is up, and gives them back after", async () => {
      const answer = deferred<BiometricAnswer>();
      const onBiometrics = jest.fn(() => answer.promise);
      await show({ biometrics: "face", onBiometrics });
      expect(button("Unlock with your face")).toBeDisabled();
      expect(button(BANK)).toBeDisabled();
      await act(async () => answer.resolve("cancelled"));
      expect(button("Unlock with your face")).toBeEnabled();
      expect(button(BANK)).toBeEnabled();
    });
  });

  describe("an iPhone not letting Kuutti use Face ID (#505)", () => {
    it("says so where the button would be, above the passcode and the bank, and asks nothing", async () => {
      const { onBiometrics } = await show({ denied: true });
      expect(screen.getByText(DENIED)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Unlock with/ })).toBeNull();
      expect(field()).toBeTruthy();
      expect(button(BANK)).toBeTruthy();
      expect(onBiometrics).not.toHaveBeenCalled();
      const flat = JSON.stringify(screen.toJSON());
      expect(flat.indexOf(DENIED)).toBeLessThan(flat.indexOf(FIELD));
      noProblems();
    });

    it("is said aloud when an ask meets it, and shown only for as long as the phone says it", async () => {
      const { view, props } = await show({
        biometrics: "face",
        onBiometrics: jest.fn(async (): Promise<BiometricAnswer> => "denied"),
      });
      expect(announced()).toEqual([DENIED]);
      await view.rerender(underProviders(<LockScreen {...props} biometrics={null} denied />));
      expect(screen.getByText(DENIED)).toBeTruthy();
      await view.rerender(underProviders(<LockScreen {...props} />));
      expect(screen.queryByText(DENIED)).toBeNull();
      expect(button(UNLOCK.face)).toBeTruthy();
    });

    it.each([
      [
        "fi-FI",
        "Tämä iPhone ei anna Kuutin käyttää Face ID:tä. Voit sallia sen puhelimen asetuksista tai käyttää toista alla olevaa tapaa.",
      ],
      [
        "sv-FI",
        "Den här iPhonen låter inte Kuutti använda Face ID. Du kan tillåta det i telefonens inställningar eller använda ett annat sätt nedan.",
      ],
    ])("speaks %s", async (languageTag, words) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
      await show({ denied: true });
      expect(screen.getByText(words)).toBeTruthy();
    });
  });

  describe("the passcode", () => {
    it("is tried at the sixth digit, then the field is emptied", async () => {
      const { onPasscode } = await show();
      await fireEvent.changeText(field(), "12345");
      expect(onPasscode).not.toHaveBeenCalled();
      await typeCode("123456");
      expect(onPasscode).toHaveBeenCalledTimes(1);
      expect(onPasscode).toHaveBeenCalledWith("123456");
      expect(field().props.value).toBe("");
    });

    it.each([
      [4, "Wrong passcode. 4 tries left."],
      [2, "Wrong passcode. 2 tries left."],
      [1, "Wrong passcode. 1 try left."],
      [0, "Wrong passcode. 0 tries left."],
    ])("says a wrong one with %p tries left, aloud on iOS", async (left, words) => {
      jest.replaceProperty(Platform, "OS", "ios");
      await show({ onPasscode: jest.fn(async (_code: string) => ({ ok: false as const, left })) });
      await typeCode("000000");
      const notice = screen.getByText(words);
      expect(notice.props.accessibilityLiveRegion).toBe("assertive");
      expect(announced()).toEqual([words]);
      expect(field().props.value).toBe("");
    });

    it("leaves a wrong one to the live region on Android", async () => {
      jest.replaceProperty(Platform, "OS", "android");
      await show();
      await typeCode("000000");
      expect(screen.getByText("Wrong passcode. 4 tries left.")).toBeTruthy();
      expect(announced()).toEqual([]);
    });

    it("says nothing when the passcode was right, and empties the field", async () => {
      jest.replaceProperty(Platform, "OS", "ios");
      await show({ onPasscode: jest.fn(async (_code: string) => ({ ok: true as const })) });
      await typeCode("123456");
      expect(screen.queryByText(/Wrong passcode/)).toBeNull();
      expect(announced()).toEqual([]);
      expect(field().props.value).toBe("");
    });

    it("says the next wrong try with the tries counted down", async () => {
      const onPasscode = jest
        .fn<Promise<PasscodeAnswer>, [string]>()
        .mockResolvedValueOnce({ ok: false, left: 4 })
        .mockResolvedValueOnce({ ok: false, left: 3 });
      await show({ onPasscode });
      await typeCode("000000");
      expect(screen.getByText("Wrong passcode. 4 tries left.")).toBeTruthy();
      await typeCode("111111");
      expect(screen.queryByText("Wrong passcode. 4 tries left.")).toBeNull();
      expect(screen.getByText("Wrong passcode. 3 tries left.")).toBeTruthy();
    });

    it("takes the notice away at the next digit, but not when the field is emptied", async () => {
      await show();
      await typeCode("000000");
      await fireEvent.changeText(field(), "");
      expect(screen.getByText("Wrong passcode. 4 tries left.")).toBeTruthy();
      await fireEvent.changeText(field(), "1");
      expect(screen.queryByText(/Wrong passcode/)).toBeNull();
      expect(field().props.value).toBe("1");
    });

    it("checks one try at a time, with the field left open so the number pad stays up", async () => {
      const answer = deferred<PasscodeAnswer>();
      const onPasscode = jest.fn((_code: string) => answer.promise);
      await show({ biometrics: "face", onPasscode });
      await fireEvent.changeText(field(), "123456");
      expect(field().props.editable).not.toBe(false);
      expect(button("Unlock with your face")).toBeDisabled();
      expect(button(BANK)).toBeDisabled();
      // What is typed while the try is checked is dropped, and starts no second try.
      await fireEvent.changeText(field(), "654321");
      expect(onPasscode).toHaveBeenCalledTimes(1);
      await act(async () => answer.resolve({ ok: false, left: 4 }));
      expect(field().props.value).toBe("");
      expect(button(BANK)).toBeEnabled();
    });
  });

  describe("the bank", () => {
    it.each([
      ["the passcode alone", { biometrics: null, passcode: true }],
      ["the face alone", { biometrics: "face", passcode: false }],
      ["both", { biometrics: "either", passcode: true }],
      ["neither", { biometrics: null, passcode: false }],
    ] as const)("is there with %s, and signs out on a press", async (_, ways) => {
      const { onBank } = await show(ways);
      await fireEvent.press(button(BANK));
      expect(onBank).toHaveBeenCalledTimes(1);
    });

    it("is there after a wrong passcode too", async () => {
      const { onBank } = await show();
      await typeCode("000000");
      await fireEvent.press(button(BANK));
      expect(onBank).toHaveBeenCalledTimes(1);
    });
  });
});
