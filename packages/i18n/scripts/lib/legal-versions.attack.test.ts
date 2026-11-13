import { expect } from "vitest";
import { attack } from "./attack.ts";
import {
  fetchPublished,
  legalVersionProblems,
  type Published,
  siteFingerprint,
} from "./legal-versions.ts";

// Attacks on check:legal-versions (#380): the app's consent versions and the
// site's part in a way the comparison may not read, or the site's document is
// missing and that reads as agreement (.claude/rules/i18n.md, the bullet on
// one version per kind; the header of legal-versions.ts).

const APP = { research: "2026-09-draft-1", terms: "2026-09-draft-1" };
const FI = {
  "legal.research.title": "Tutkimus",
  "legal.research.summary": "LUONNOS: tutkimus.",
};
const SITE: Published = {
  terms: {
    version: "2026-09-draft-1",
    hash: "65b7fa7d00ed9290",
    language: "en",
    url: "https://kuutti.app/legal/terms/#terms-2026-09-draft-1",
  },
  research: {
    version: "2026-09-draft-1",
    hash: siteFingerprint(FI["legal.research.title"], FI["legal.research.summary"]),
    language: "fi",
    url: "https://kuutti.app/legal/privacy/#research-2026-09-draft-1",
  },
};
const research = SITE.research as Published[string];
const terms = SITE.terms as Published[string];

const silent = (seen: string[]) => expect(seen).toEqual([]);
const agreed = () => legalVersionProblems(APP, SITE, FI);

/** What is tried, and the two sides as they then stand. */
const PARTED: [string, () => string[]][] = [
  [
    "a kind the site names with a capital",
    () => legalVersionProblems(APP, { terms, Research: research }, FI),
  ],
  [
    "an address that differs from the app's link by one slash",
    () =>
      legalVersionProblems(
        APP,
        { ...SITE, terms: { ...terms, url: terms.url.replace("/#", "#") } },
        FI,
      ),
  ],
  [
    "a research text the site calls Finnish of Finland, not Finnish",
    () => legalVersionProblems(APP, { ...SITE, research: { ...research, language: "fi-FI" } }, FI),
  ],
  [
    "a Finnish research title that changed only in its capitals",
    () => legalVersionProblems(APP, SITE, { ...FI, "legal.research.title": "TUTKIMUS" }),
  ],
  ["a Finnish research wording the app no longer has", () => legalVersionProblems(APP, SITE, {})],
  [
    "a version the app carries with a space after it",
    () => legalVersionProblems({ ...APP, terms: `${APP.terms} ` }, SITE, FI),
  ],
];

for (const [name, parted] of PARTED) {
  attack(`check:legal-versions: ${name} passes`, {
    attempt: parted,
    control: agreed,
    succeeds: silent,
  });
}

// What goes through today (#380): a question, where no line says what should happen.
const QUESTION = "#380, a question";

// "Nothing found, read as nothing wrong": neither side names a kind. The
// comparison goes kind by kind, and with no kind on either side asks nothing.
attack("check:legal-versions: an app and a site that both name no kind at all agree", {
  attempt: () => legalVersionProblems({}, {}, FI),
  control: agreed,
  succeeds: silent,
  open: QUESTION,
});

/** How reading the site's document ended: the kinds it gave, or the refusal. */
const reading = async (answer: () => Response) => {
  try {
    return Object.keys(await fetchPublished(async () => answer(), "https://site.test/v.json"));
  } catch (error) {
    return `refused: ${(error as Error).message}`;
  }
};

/** What is tried, and the site's answer. */
const UNREADABLE: [string, () => Response][] = [
  ["an answer with no body at all", () => new Response(null, { status: 204 })],
  ["an answer that is JSON's null", () => new Response("null")],
  ["an answer that is a list of kinds", () => new Response(JSON.stringify([SITE.terms]))],
  [
    "a page that says the file has moved",
    () => new Response("<html>Moved</html>", { status: 301 }),
  ],
];

for (const [name, answer] of UNREADABLE) {
  attack(`check:legal-versions: ${name} is read as the site's document`, {
    attempt: () => reading(answer),
    control: () => reading(() => new Response(JSON.stringify(SITE))),
    succeeds: (seen) => expect(Array.isArray(seen)).toBe(true),
  });
}
