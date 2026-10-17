import { createHash } from "node:crypto";
import { z } from "zod";
import { isLegalTextKind, LEGAL_SITE, legalPageUrl } from "../../src/legal.ts";

/**
 * One version per kind, two renderings (#208, ADR-010 §4): the app's summary
 * and the site's full text carry the same consent_version, and each
 * repository pins its own text to it by a fingerprint. The site's build
 * publishes its versions here; the app's CONSENT_VERSIONS must be the same,
 * and its links must lead where the site says each version is read.
 */
export const VERSIONS_URL = `${LEGAL_SITE}/legal/versions.json`;

/**
 * What the app reads of the site's document: per kind, the version, the
 * address of its text, and the fingerprint of the text with its language.
 * The day is the site's alone.
 */
const Published = z.record(
  z.string(),
  z.object({
    version: z.string().min(1),
    hash: z.string().regex(/^[0-9a-f]{16}$/),
    language: z.string().min(1),
    url: z.string().min(1),
  }),
);
export type Published = z.infer<typeof Published>;

/** Throws, saying what is wrong, when the document is not what the site's build writes. */
export function parsePublished(text: string): Published {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("is not JSON");
  }
  const parsed = Published.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `is not a versions document: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(the document)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * The kinds whose text on the site is this app's own wording, verbatim
 * (kuutti-app-site src/content/consents): the research opt-in and the
 * sensitive answers have no longer text than legal.<kind>.title and summary.
 */
const VERBATIM_KINDS: readonly string[] = ["research", "special_category"];

/**
 * The site's fingerprint of a consent's wording (`pinnedText` and
 * `fingerprint` in kuutti-app-site src/lib/consent.ts): the first 16 hex
 * digits of the SHA-256 of `# <heading>`, a blank line and the body, with LF
 * line ends and no blank edges. Not CONSENT_TEXT_HASHES, which hashes the
 * keys too: the two values are not comparable.
 */
export function siteFingerprint(title: string, body: string): string {
  const normal = (text: string) => text.replace(/\r\n?/g, "\n").trim();
  return createHash("sha256")
    .update(`# ${normal(title)}\n\n${normal(body)}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

const TRIES = 3;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The site's document as it is deployed. A network failure or a 5xx is tried
 * three times, five and then ten seconds apart, so a blip at the host does
 * not fail every pull request; any other answer but a 2xx fails at once, and
 * so does the third failure: a missing or unreadable file is never a pass.
 */
export async function fetchPublished(
  fetchImpl: typeof fetch = fetch,
  url: string = VERSIONS_URL,
  pause: (ms: number) => Promise<void> = wait,
): Promise<Published> {
  let response: Response | undefined;
  for (let attempt = 1; response === undefined; attempt++) {
    try {
      const answer = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (answer.status < 500 || attempt >= TRIES) response = answer;
    } catch (error) {
      if (attempt >= TRIES) throw error;
    }
    if (response === undefined) await pause(attempt * 5_000);
  }
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  try {
    return parsePublished(await response.text());
  } catch (error) {
    throw new Error(`${url} ${(error as Error).message}`);
  }
}

/**
 * The app's versions against the site's, kind by kind: the same version, the
 * app's link to it (`legalPageUrl`) the address the site publishes, and for
 * the research opt-in and the sensitive answers, whose text on the site is
 * this app's Finnish legal.<kind>.title and summary, the same fingerprint, so
 * the two copies cannot part under one version. The site leads, since its
 * Finnish text is the one that binds: a new version is published there
 * first, and this fails until the app carries it too.
 */
export function legalVersionProblems(
  app: Readonly<Record<string, string>>,
  published: Published,
  finnish: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  for (const [kind, version] of Object.entries(app)) {
    const site = published[kind];
    if (!site) {
      problems.push(`${kind}: the site publishes no version of it (the app carries ${version})`);
    } else if (site.version !== version) {
      problems.push(
        `${kind}: the app carries ${version}, the site publishes ${site.version} (${site.url}). ` +
          `The site's text leads: a new version lands there first, and the app follows with the same ` +
          `consent_version on legal.${kind}.*, its summary in line with the text, and the golden row ` +
          `of src/consent.test.ts`,
      );
    } else if (!isLegalTextKind(kind)) {
      problems.push(`${kind}: the app has no page for it to link to (src/legal.ts)`);
    } else {
      if (legalPageUrl(kind, version) !== site.url) {
        problems.push(
          `${kind}: the app links to ${legalPageUrl(kind, version)}, the site publishes the text at ${site.url}`,
        );
      }
      const ours = siteFingerprint(
        finnish[`legal.${kind}.title`] ?? "",
        finnish[`legal.${kind}.summary`] ?? "",
      );
      if (VERBATIM_KINDS.includes(kind) && (site.language !== "fi" || site.hash !== ours)) {
        problems.push(
          `${kind}: the site's text of ${version} (${site.language}, ${site.hash}) is not this app's ` +
            `Finnish legal.${kind}.title and summary (fi, ${ours}). The site carries this wording ` +
            `as the app has it, so one of the two changed without the other: one version, one text`,
        );
      }
    }
  }
  for (const kind of Object.keys(published)) {
    if (!Object.hasOwn(app, kind)) {
      problems.push(`${kind}: the site publishes a version of a kind the app does not know`);
    }
  }
  return problems;
}
