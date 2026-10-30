import { fireEvent, screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { Dimensions, Linking } from "react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { SupportScreen } from "./SupportScreen";
import { numbersOf, openQuietly, SUPPORT_LINES, siteOf, telOf } from "./support-lines";

// Where to turn when it is hard (#510): mental and emotional support, four
// services and 112. The numbers, hours and sites are the page's whole worth,
// so they are spelt out here against the services' own sites, not read from
// the list they test. That no crash report names the page is in lib/sentry.test.ts.

const phoneLanguage = (languageTag: string) =>
  (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);

const atSize = (width: number, fontScale: number) =>
  jest.spyOn(Dimensions, "get").mockReturnValue({ width, height: 812, scale: 3, fontScale });

beforeEach(() => {
  phoneLanguage("en");
  atSize(393, 1);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const opened = () => jest.spyOn(Linking, "openURL").mockClear().mockResolvedValue(true);

describe("the support page (#510)", () => {
  it("says it is a page of its own, with the pinned way back", async () => {
    await renderWithTheme(<SupportScreen />);
    expectPinnedHeader("Support when it's hard", "Back");
  });

  it.each([
    ["en", "MIELI Crisis Helpline", "Nollalinja", "Victim Support Finland"],
    ["fi", "MIELI Kriisipuhelin", "Nollalinja", "Rikosuhripäivystys"],
    ["sv", "MIELI Kristelefonen", "Nollinjen", "Brottsofferjouren"],
  ])("names the four services, the two open all hours first, in %s", async (language, ...names) => {
    phoneLanguage(language);
    await renderWithTheme(<SupportScreen />);
    // The page's own title comes first, then the tiles.
    const headings = screen.getAllByRole("heading").slice(1);
    expect(headings.map((node) => node.props.children)).toEqual([...names, "Tukinainen"]);
  });

  it("says what each service is for", async () => {
    await renderWithTheme(<SupportScreen />);
    expect(screen.getByText(/thoughts of suicide/)).toBeTruthy();
    expect(screen.getByText(/by a partner or someone close, whatever your gender/)).toBeTruthy();
    expect(screen.getByText(/even if you only suspect it/)).toBeTruthy();
    expect(screen.getByText(/Sexual violence or crossed boundaries/)).toBeTruthy();
  });

  it.each([
    ["en", /For every gender/],
    ["fi", /Kaikille sukupuolesta riippumatta/],
    ["sv", /För alla oavsett kön/],
  ])(
    "says in %s that Tukinainen is for every gender, its name holding the word for woman",
    async (language, words) => {
      phoneLanguage(language);
      await renderWithTheme(<SupportScreen />);
      expect(screen.getByText(words)).toBeTruthy();
    },
  );

  it.each([
    ["en", /^Every day, all hours, in Finnish\. You pay only your operator's call rate\.$/],
    ["en", /^Every day, all hours, in Finnish, Swedish and English\. Free and not on/],
    ["en", /^Mon–Thu 9–18, Fri 9–16, mainly in Finnish\. For English, use the contact form/],
    ["en", /^Mon and Wed 12–15\. Free\. The hours may change around the turn of the year\./],
    ["fi", /^Joka päivä, ympäri vuorokauden\. Maksat puhelusta vain operaattorisi hinnan\.$/],
    ["fi", /^Joka päivä, ympäri vuorokauden\. Puhelu on maksuton eikä näy puhelinlaskussa/],
    ["fi", /^Ma–to klo 9–18, pe klo 9–16\. Maksuton\.$/],
    ["fi", /^Ma ja ke klo 12–15\. Maksuton\. Ajat voivat muuttua vuodenvaihteessa\.$/],
    [
      "sv",
      /^Svenska linjen: må och ons kl\. 16–20, tis, tors och fre kl\. 9–13\. Finska linjen: dygnet/,
    ],
    ["sv", /^Alla dagar, dygnet runt, på svenska, finska och engelska\. Gratis och syns inte/],
    [
      "sv",
      /^På svenska må–fre kl\. 12–14, på finska må–tors kl\. 9–18 och fre kl\. 9–16\. Gratis\.$/,
    ],
    ["sv", /^Må och ons kl\. 12–15\. Gratis\. Tiderna kan ändras kring årsskiftet\./],
  ])("says the hours in %s: %s", async (language, hours) => {
    phoneLanguage(language);
    await renderWithTheme(<SupportScreen />);
    expect(screen.getByText(hours)).toBeTruthy();
  });

  it.each([
    ["en", /but it stays in your phone's call history\.$/],
    ["fi", /mutta jää puhelimen soittohistoriaan\.$/],
    ["sv", /men stannar i telefonens samtalslogg\.$/],
  ])(
    "does not let a call off the bill pass for a call that leaves no trace, in %s",
    async (language, words) => {
      phoneLanguage(language);
      await renderWithTheme(<SupportScreen />);
      expect(screen.getByText(words)).toBeTruthy();
    },
  );

  it.each([
    ["en", /If a line is busy, try again in a moment\.$/],
    ["fi", /Jos linja on varattu, soita hetken päästä uudelleen\.$/],
    ["sv", /Om linjen är upptagen, ring igen om en stund\.$/],
  ])(
    "says before anybody hears the tone that a line may be busy, in %s",
    async (language, words) => {
      phoneLanguage(language);
      await renderWithTheme(<SupportScreen />);
      expect(screen.getByText(words)).toBeTruthy();
    },
  );

  it.each([
    ["en", "MIELI Crisis Helpline", "Call", "09 2525 0111", "tel:0925250111"],
    ["en", "Nollalinja", "Call", "116 016", "tel:116016"],
    ["en", "Victim Support Finland", "Call", "116 006", "tel:116006"],
    ["en", "Tukinainen", "Call", "0800 97899", "tel:080097899"],
    ["fi", "MIELI Kriisipuhelin", "Soita:", "09 2525 0111", "tel:0925250111"],
    ["fi", "Nollalinja", "Soita:", "116 016", "tel:116016"],
    ["fi", "Rikosuhripäivystys", "Soita:", "116 006", "tel:116006"],
    ["fi", "Tukinainen", "Soita:", "0800 97899", "tel:080097899"],
  ])("in %s calls %s from its number", async (language, name, verb, number, link) => {
    phoneLanguage(language);
    const open = opened();
    await renderWithTheme(<SupportScreen />);
    expect(screen.getByText(number)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: `${verb} ${name}, ${number}` }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(link);
  });

  it("offers somebody reading Swedish both of MIELI's lines, named, the one that answers at night among them", async () => {
    phoneLanguage("sv");
    const open = opened();
    await renderWithTheme(<SupportScreen />);
    expect(screen.getByText("På svenska")).toBeTruthy();
    expect(screen.getByText("På finska")).toBeTruthy();
    await fireEvent.press(
      screen.getByRole("button", { name: "Ring: MIELI Kristelefonen, 09 2525 0112" }),
    );
    expect(open).toHaveBeenLastCalledWith("tel:0925250112");
    await fireEvent.press(
      screen.getByRole("button", { name: "Ring: MIELI Kristelefonen, 09 2525 0111" }),
    );
    expect(open).toHaveBeenLastCalledWith("tel:0925250111");
  });

  it.each([
    ["en", "In immediate danger, call 112"],
    ["fi", "Jos olet välittömässä vaarassa, soita 112"],
    ["sv", "Är du i omedelbar fara, ring 112"],
  ])("offers 112 before the services, in %s", async (language, words) => {
    phoneLanguage(language);
    const open = opened();
    await renderWithTheme(<SupportScreen />);
    const flat = JSON.stringify(screen.toJSON());
    expect(flat.indexOf(words)).toBeGreaterThan(-1);
    expect(flat.indexOf(words)).toBeLessThan(flat.indexOf("MIELI"));
    await fireEvent.press(screen.getByRole("button", { name: words }));
    expect(open).toHaveBeenCalledWith("tel:112");
  });

  it.each([
    ["en", "MIELI Crisis Helpline, website", "https://mieli.fi/tukea-ja-apua/kriisipuhelin/"],
    ["fi", "MIELI Kriisipuhelin, verkkosivut", "https://mieli.fi/tukea-ja-apua/kriisipuhelin/"],
    ["sv", "MIELI Kristelefonen, webbplats", "https://mieli.fi/sv/stod-och-hjalp/kristelefon/"],
    ["en", "Nollalinja, website", "https://nollalinja.fi/en/"],
    ["fi", "Nollalinja, verkkosivut", "https://nollalinja.fi/"],
    ["sv", "Nollinjen, webbplats", "https://nollalinja.fi/sv/"],
    [
      "en",
      "Victim Support Finland, website",
      "https://www.riku.fi/en/services/victim-support-finland-116-006/",
    ],
    [
      "fi",
      "Rikosuhripäivystys, verkkosivut",
      "https://www.riku.fi/palvelut/rikosuhripaivystys-116-006/",
    ],
    [
      "sv",
      "Brottsofferjouren, webbplats",
      "https://www.riku.fi/sv/tjansterna/brottsofferjouren-116-006/",
    ],
    ["en", "Tukinainen, website", "https://tukinainen.fi/rape-crises-center-tukinainen/"],
    [
      "fi",
      "Tukinainen, verkkosivut",
      "https://tukinainen.fi/kriisituki-seksuaalivakivallan-kokemuksen-jalkeen/",
    ],
    [
      "sv",
      "Tukinainen, webbplats",
      "https://tukinainen.fi/kriisituki-seksuaalivakivallan-kokemuksen-jalkeen/",
    ],
  ])("in %s opens %s in the browser", async (language, name, url) => {
    phoneLanguage(language);
    const open = opened();
    await renderWithTheme(<SupportScreen />);
    await fireEvent.press(screen.getByRole("link", { name }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(url);
  });

  it.each([
    [
      "en",
      "These services are not part of Kuutti. Kuutti doesn't see who opens this page or who you call.",
    ],
    [
      "fi",
      "Nämä palvelut eivät kuulu Kuuttiin. Kuutti ei näe, kuka avaa tämän sivun tai kenelle soitat.",
    ],
    [
      "sv",
      "De här tjänsterna hör inte till Kuutti. Kuutti ser inte vem som öppnar den här sidan eller vem du ringer.",
    ],
  ])(
    "says the services are not Kuutti's and that Kuutti does not see, in %s",
    async (language, words) => {
      phoneLanguage(language);
      await renderWithTheme(<SupportScreen />);
      expect(screen.getByText(words)).toBeTruthy();
    },
  );

  it.each([
    ["a common phone", 393, 1, true],
    ["the narrowest width of two columns", 380, 1, true],
    ["just under it, an iPhone SE", 375, 1, false],
    ["a narrow phone", 320, 1, false],
    ["a large text size", 393, 1.3, false],
    ["the largest text size", 430, 2, false],
  ])("lays the services out for %s", async (_size, width, fontScale, twoColumns) => {
    atSize(width, fontScale);
    await renderWithTheme(<SupportScreen />);
    expect(screen.getByTestId("support-grid").props.className.includes("flex-row")).toBe(
      twoColumns,
    );
    expect(JSON.stringify(screen.toJSON()).includes("basis-[48%]")).toBe(twoColumns);
  });

  it("keeps the logos from a screen reader: the names say the same in words", async () => {
    await renderWithTheme(<SupportScreen />);
    const logos = screen.getAllByTestId("support-logo", { includeHiddenElements: true });
    expect(logos).toHaveLength(4);
    for (const logo of logos) {
      expect(logo.props.accessibilityElementsHidden).toBe(true);
      expect(logo.props.importantForAccessibility).toBe("no");
    }
  });

  it("names every control and makes it big enough", async () => {
    await renderWithTheme(<SupportScreen />);
    const controls = pressables(screen.toJSON() as HostNode);
    expect(controls.flatMap((node) => a11yProblems(node))).toEqual([]);
    // Back, 112, and a number and a site on each of the four tiles.
    expect(controls).toHaveLength(10);
  });

  it("asks nothing of the network: who opens the page is nobody's business", async () => {
    const network = jest.spyOn(globalThis, "fetch");
    await renderWithTheme(<SupportScreen />);
    expect(network).not.toHaveBeenCalled();
  });
});

describe("the list of lines (#510)", () => {
  const mieli = SUPPORT_LINES[0];
  if (!mieli) throw new Error("the list is empty");

  it("takes the spaces out of a number", () => {
    expect(telOf("09 2525 0111")).toBe("tel:0925250111");
    expect(telOf("116 016")).toBe("tel:116016");
    expect(telOf("112")).toBe("tel:112");
  });

  it("gives MIELI's two lines in Swedish alone, and every other service one number everywhere", () => {
    expect(numbersOf(mieli, "sv").map(({ number }) => number)).toEqual([
      "09 2525 0112",
      "09 2525 0111",
    ]);
    for (const locale of ["en", "fi", "en-XA"] as const) {
      expect(numbersOf(mieli, locale)).toEqual([{ number: "09 2525 0111" }]);
    }
    for (const line of SUPPORT_LINES.slice(1)) {
      expect(numbersOf(line, "sv")).toEqual([{ number: line.phone }]);
    }
  });

  it("reads English in the pseudo-locale", () => {
    for (const line of SUPPORT_LINES) {
      expect(siteOf(line, "en-XA")).toBe(line.site.en);
    }
  });

  it("keeps a refusal quiet: a device that cannot call rejects, and nothing goes unhandled", async () => {
    const open = jest.spyOn(Linking, "openURL").mockRejectedValue(new Error("no calling here"));
    await expect(openQuietly("tel:112")).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledWith("tel:112");
  });
});
