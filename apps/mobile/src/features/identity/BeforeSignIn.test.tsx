import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { fireEvent, screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { Linking, ScrollView } from "react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { BeforeSignIn, NormsAndConsents } from "./BeforeSignIn";

// The screens before the bank login (#418, ADR-010 §15): the norms with the
// terms and the privacy summary, which must be accepted to go on, then the
// research question, a yes or a no that both go on to the bank. Nothing is
// sent from here: there is no account yet.

const TERMS = String(CONSENT_VERSIONS.terms);
const PRIVACY = String(CONSENT_VERSIONS.privacy);
const RESEARCH = String(CONSENT_VERSIONS.research);
const fetchMock = jest.fn();

const checkA11y = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);
const onPhone = (languageTag: string) =>
  (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  jest.restoreAllMocks();
  onPhone("en-US");
  // Nothing before the bank reaches the API.
  expect(fetchMock).not.toHaveBeenCalled();
});

describe("BeforeSignIn: the terms and the privacy summary", () => {
  it("shows the norms and both summaries with their versions, and one way on, with no accessibility problems", async () => {
    await renderWithTheme(<BeforeSignIn onAgreed={jest.fn()} />);
    expect(screen.getByRole("heading", { name: "Before you sign in" })).toBeTruthy();
    expect(screen.getByText("How we do things here")).toBeTruthy();
    expect(screen.getByText(/One round a day/)).toBeTruthy();
    expect(screen.getByText("Terms of use")).toBeTruthy();
    expect(screen.getByText("Privacy")).toBeTruthy();
    // Both wordings carry the same version today; each card has its own link.
    expect(
      screen.getAllByRole("link", {
        name: `Read the full text on kuutti.app (version ${TERMS})`,
      }),
    ).toHaveLength(TERMS === PRIVACY ? 2 : 1);
    expect(screen.getAllByRole("link")).toHaveLength(2);
    // The research question waits for the next step; no bank button anywhere.
    expect(screen.queryByText("Help us learn how matching works")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in with your bank" })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "I'm in, and I accept both" })).toBeTruthy();
    checkA11y();
  });

  it("opens each summary's full text at the version it names", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await renderWithTheme(<BeforeSignIn onAgreed={jest.fn()} />);
    const links = screen.getAllByRole("link");
    await fireEvent.press(links[0] as (typeof links)[number]);
    await fireEvent.press(links[1] as (typeof links)[number]);
    expect(open.mock.calls.map((call) => call[0])).toEqual([
      `https://kuutti.app/legal/terms/#terms-${TERMS}`,
      `https://kuutti.app/legal/privacy/#privacy-${PRIVACY}`,
    ]);
    // Reading the full text is no answer: the screen stays where it was.
    expect(screen.getByRole("button", { name: "I'm in, and I accept both" })).toBeTruthy();
  });

  it.each([
    ["en-US", "The Finnish text is the one that counts; this is a translation."],
    ["sv-FI", "Den finska texten är den som gäller; det här är en översättning."],
  ])("says on a %s phone that the Finnish text is the binding one", async (languageTag, line) => {
    onPhone(languageTag);
    await renderWithTheme(<BeforeSignIn onAgreed={jest.fn()} />);
    expect(screen.getByText(line)).toBeTruthy();
  });

  it("says nothing of a binding text on a Finnish phone, whose text is the binding one", async () => {
    onPhone("fi-FI");
    await renderWithTheme(<BeforeSignIn onAgreed={jest.fn()} />);
    expect(screen.getByRole("heading", { name: "Ennen kuin kirjaudut" })).toBeTruthy();
    expect(screen.getByText("Näin täällä toimitaan")).toBeTruthy();
    expect(screen.queryByText(/Suomenkielinen teksti on sitova/)).toBeNull();
  });

  it("shows the same norms and summaries on its own, as the welcome step uses it", async () => {
    await renderWithTheme(<NormsAndConsents />);
    expect(screen.getByText("How we do things here")).toBeTruthy();
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "Before you sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "I'm in, and I accept both" })).toBeNull();
  });
});

describe("BeforeSignIn: research", () => {
  /** Past the first step, as a person who accepted both. */
  async function atResearch(onAgreed = jest.fn()) {
    await renderWithTheme(<BeforeSignIn onAgreed={onAgreed} />);
    await fireEvent.press(screen.getByRole("button", { name: "I'm in, and I accept both" }));
    return onAgreed;
  }

  it("asks research next, with its summary, its version and that either answer leads on, from the top", async () => {
    const scrollTo = jest.spyOn(ScrollView.prototype, "scrollTo");
    const onAgreed = await atResearch();
    expect(screen.getByRole("heading", { name: "Before you sign in" })).toBeTruthy();
    expect(screen.getByText("Help us learn how matching works")).toBeTruthy();
    expect(screen.getByText("Research")).toBeTruthy();
    expect(screen.getByText("You can change this later, at any time.")).toBeTruthy();
    expect(
      screen.getByText("Either answer takes you on to the sign-in with your bank."),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: `Read the full text on kuutti.app (version ${RESEARCH})` }),
    ).toBeTruthy();
    // The first step is gone, and accepting it answered nothing yet.
    expect(screen.queryByText("How we do things here")).toBeNull();
    expect(onAgreed).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledWith({ y: 0, animated: false });
    checkA11y();
  });

  it("offers the yes and the no with equal weight and neither chosen beforehand", async () => {
    await atResearch();
    const yes = screen.getByRole("button", { name: "Yes, I take part" });
    const no = screen.getByRole("button", { name: "Not now" });
    expect(yes.props.className).toBe(no.props.className);
    expect(yes.props.className).toMatch(/\bborder-input\b/);
    expect(yes.props.className).not.toMatch(/\bbg-primary\b/);
    for (const button of [yes, no]) {
      expect(button.props.accessibilityState?.selected).toBeFalsy();
      expect(button.props.accessibilityState?.disabled).toBeFalsy();
    }
  });

  it("Research before the bank is a yes or a no, and either goes on to the bank", async () => {
    const onYes = await atResearch();
    await fireEvent.press(screen.getByRole("button", { name: "Yes, I take part" }));
    expect(onYes).toHaveBeenCalledTimes(1);
    expect(onYes).toHaveBeenCalledWith({
      terms: TERMS,
      privacy: PRIVACY,
      research: RESEARCH,
      locale: "en",
    });

    const onNo = await atResearch();
    await fireEvent.press(screen.getByRole("button", { name: "Not now" }));
    expect(onNo).toHaveBeenCalledTimes(1);
    // A no names no research wording: it records nothing and withdraws nothing.
    expect(onNo).toHaveBeenCalledWith({
      terms: TERMS,
      privacy: PRIVACY,
      research: null,
      locale: "en",
    });
  });

  it.each([
    ["fi-FI", "fi", "Olen mukana ja hyväksyn molemmat", "Kyllä, osallistun", null],
    [
      "sv-FI",
      "sv",
      "Jag är med och godkänner båda",
      "Ja, jag deltar",
      "Den finska texten är den som gäller; det här är en översättning.",
    ],
    [
      "en-US",
      "en",
      "I'm in, and I accept both",
      "Yes, I take part",
      "The Finnish text is the one that counts; this is a translation.",
    ],
  ])(
    "names the language of a %s phone's texts as %s, with the binding line outside Finnish",
    async (languageTag, locale, accept, yes, binding) => {
      onPhone(languageTag);
      const onAgreed = jest.fn();
      await renderWithTheme(<BeforeSignIn onAgreed={onAgreed} />);
      await fireEvent.press(screen.getByRole("button", { name: accept }));
      expect(screen.queryByRole("button", { name: accept })).toBeNull();
      if (binding) expect(screen.getByText(binding)).toBeTruthy();
      else expect(screen.queryByText(/Suomenkielinen teksti on sitova/)).toBeNull();
      await fireEvent.press(screen.getByRole("button", { name: yes }));
      expect(onAgreed).toHaveBeenCalledWith(expect.objectContaining({ locale }));
    },
  );
});
