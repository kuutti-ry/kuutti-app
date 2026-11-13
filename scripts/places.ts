/**
 * places: Finland's postal areas and municipalities, read from Statistics
 * Finland into the repository (ADR-061 §4, #514). No table: the list is public
 * and read-only, the pool needs it in memory, and a diff in a pull request is
 * the right review.
 *
 * It reads two public layers of Statistics Finland's WFS (CC BY 4.0):
 * - postialue:pno_tilasto_<year> (Paavo), one row per postal area: its names,
 *   its municipality, its centre in ETRS-TM35FIN metres, its inhabitants;
 * - tilastointialueet:kunta4500k_<year>, the municipalities' names.
 * and writes three files, or none:
 * - packages/schema/src/postal-areas.generated.ts, codes and names, which the
 *   phone's autocomplete reads, and the credit as one meta object;
 * - packages/schema/src/postal-areas.NOTICE.md, the same credit beside the data;
 * - apps/api/src/pond/places.generated.ts, the areas' centres and inhabitants,
 *   and the municipalities, whose inhabitants are their areas' sum and whose
 *   centre is the inhabitant-weighted mean of their areas' centres.
 *
 * What it fetched stays data: every value is held to a shape before anything
 * is written, and a name in particular, since it lands in a template string of
 * a file the API runs. Nothing fetched is ever run. A -1 he_vakiy, how Paavo
 * hides a figure, is written as it is, under any floor, and counts for nobody.
 * Municipality names lose the bilingual " - " form; area names keep theirs.
 *
 * Usage:
 *   pnpm places                   read this year's layers and write the files
 *   pnpm places -- --year 2026    or those of a given year
 *   node scripts/places.ts --self-test    over a fixture, never the network
 * Run it when Statistics Finland publishes a year, and read the diff: a key a
 * new list has lost reads as no home (ADR-061 §2).
 * No dependencies. Needs Node 22.18+ (type stripping).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

type Field = Record<string, unknown>;
type Get = (url: string) => Promise<Response>;
type Layer = { workspace: string; name: string; fields: readonly string[] };
type Area = {
  code: string;
  fi: string;
  sv: string;
  municipality: string;
  x: number;
  y: number;
  inhabitants: number;
};
type Municipality = {
  code: string;
  fi: string;
  sv: string;
  x: number;
  y: number;
  inhabitants: number;
  alwaysTown: boolean;
};
type Words = { source: string; changes: string };
type Credit = {
  year: number;
  date: string;
  licence: string;
  licenceUrl: string;
  sourceUrl: string;
  en: Words;
  fi: Words;
};

const ROOT = join(import.meta.dirname, "..");
const WFS = "https://geo.stat.fi/geoserver";
const LICENCE = "CC BY 4.0";
const LICENCE_URL = "https://creativecommons.org/licenses/by/4.0/";
const POSTAL_FILE = "packages/schema/src/postal-areas.generated.ts";
const NOTICE_FILE = "packages/schema/src/postal-areas.NOTICE.md";
const PLACES_FILE = "apps/api/src/pond/places.generated.ts";
/** Biome's line width, which the object of the credit is written to. */
const LINE = 100;
/** The contract's PLACE_NAME_MAX: a longer name would refuse every card that shows it. */
const NAME_MAX = 80;
/** Letters, digits and the punctuation of a name: never what ends a template string or a row. */
const NAME = /^[\p{L}\p{N} .,:'()/-]+$/u;
/** ETRS-TM35FIN metres around Finland, so that another coordinate system is refused, not written. */
const EAST = { min: 0, max: 1_000_000 };
const NORTH = { min: 6_000_000, max: 8_000_000 };
/** Maarianhamina counts as a town at any size, so that Åland is not sent across the sea (ADR-061 §3). */
const ALWAYS_A_TOWN = new Set(["478"]);

const areaLayer = (year: number): Layer => ({
  workspace: "postialue",
  name: `pno_tilasto_${year}`,
  fields: ["postinumeroalue", "nimi", "namn", "kunta", "euref_x", "euref_y", "he_vakiy"],
});
const municipalityLayer = (year: number): Layer => ({
  workspace: "tilastointialueet",
  name: `kunta4500k_${year}`,
  fields: ["kunta", "nimi", "namn"],
});

/** Every row of a layer, or a refusal: a list cut short by the service is never written. */
async function readLayer(get: Get, { workspace, name, fields }: Layer): Promise<Field[]> {
  const query = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeName: `${workspace}:${name}`,
    outputFormat: "application/json",
    propertyName: fields.join(","),
  });
  const response = await get(`${WFS}/${workspace}/wfs?${query}`);
  if (!response.ok) {
    throw new Error(`${name}: the service answered ${response.status}; is the year published?`);
  }
  let body: { features?: { properties?: Field }[]; numberMatched?: unknown };
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new Error(`${name}: the service did not answer in JSON`);
  }
  const rows = (body.features ?? []).map((feature) => feature.properties ?? {});
  if (rows.length === 0 || rows.length !== body.numberMatched) {
    throw new Error(`${name}: ${rows.length} rows of ${String(body.numberMatched)}`);
  }
  return rows;
}

function nameOf(value: unknown, where: string): string {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (name === "" || name.length > NAME_MAX || !NAME.test(name)) {
    throw new Error(`${where}: a name this list does not take`);
  }
  return name;
}

function codeOf(value: unknown, digits: number, where: string): string {
  if (typeof value !== "string" || !new RegExp(`^\\d{${digits}}$`).test(value)) {
    throw new Error(`${where}: a code of ${digits} digits was expected`);
  }
  return value;
}

function wholeOf(value: unknown, bounds: { min: number; max: number }, where: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${where}: a whole number was expected`);
  const number = value as number;
  if (number < bounds.min || number > bounds.max) throw new Error(`${where}: out of bounds`);
  return number;
}

function areasFrom(rows: Field[]): Area[] {
  const seen = new Set<string>();
  const areas = rows.map((row, index) => {
    const code = codeOf(row.postinumeroalue, 5, `area row ${index}`);
    if (seen.has(code)) throw new Error(`area ${code}: twice`);
    seen.add(code);
    return {
      code,
      fi: nameOf(row.nimi, `area ${code}`),
      sv: nameOf(row.namn, `area ${code}`),
      municipality: codeOf(row.kunta, 3, `area ${code}`),
      x: wholeOf(row.euref_x, EAST, `area ${code}, east`),
      y: wholeOf(row.euref_y, NORTH, `area ${code}, north`),
      inhabitants: wholeOf(row.he_vakiy, { min: -1, max: 1_000_000 }, `area ${code}, inhabitants`),
    };
  });
  return areas.sort((a, b) => (a.code < b.code ? -1 : 1));
}

/** A hidden figure counts for nobody; if nobody is left to weigh by, each area counts the same. */
function municipalityOf(row: Field, index: number, areas: Map<string, Area[]>): Municipality {
  const code = codeOf(row.kunta, 3, `municipality row ${index}`);
  const own = areas.get(code);
  if (!own) throw new Error(`municipality ${code}: no postal area, so no centre`);
  const counted = (area: Area) => Math.max(0, area.inhabitants);
  const inhabitants = own.reduce((sum, area) => sum + counted(area), 0);
  const weight = inhabitants > 0 ? counted : () => 1;
  const weights = own.reduce((sum, area) => sum + weight(area), 0);
  const mean = (axis: "x" | "y") =>
    Math.round(own.reduce((sum, area) => sum + weight(area) * area[axis], 0) / weights);
  const single = (value: unknown) => nameOf(value, `municipality ${code}`).split(" - ")[0] ?? "";
  return {
    code,
    fi: single(row.nimi),
    sv: single(row.namn),
    x: mean("x"),
    y: mean("y"),
    inhabitants,
    alwaysTown: ALWAYS_A_TOWN.has(code),
  };
}

function municipalitiesFrom(rows: Field[], areas: Area[]): Municipality[] {
  const byMunicipality = new Map<string, Area[]>();
  for (const area of areas) {
    byMunicipality.set(area.municipality, [...(byMunicipality.get(area.municipality) ?? []), area]);
  }
  const municipalities = rows.map((row, index) => municipalityOf(row, index, byMunicipality));
  const known = new Set(municipalities.map((municipality) => municipality.code));
  if (known.size !== municipalities.length) throw new Error("a municipality twice");
  for (const code of byMunicipality.keys()) {
    if (!known.has(code)) throw new Error(`municipality ${code}: areas, but no name`);
  }
  return municipalities.sort((a, b) => (a.code < b.code ? -1 : 1));
}

function creditOf(year: number, date: string): Credit {
  const [yyyy, mm, dd] = date.split("-");
  const day = `${Number(dd)}.${Number(mm)}.${yyyy}`;
  return {
    year,
    date,
    licence: LICENCE,
    licenceUrl: LICENCE_URL,
    sourceUrl: WFS,
    en: {
      source: `Paavo, open data by postal code area ${year}, and Municipalities ${year} (1:4 500 000), Statistics Finland. Downloaded from Statistics Finland's interface service on ${day}, licence ${LICENCE}, ${LICENCE_URL}.`,
      changes:
        "Changed by Kuutti: only the codes, names, municipalities, inhabitants and centre points are used; a municipality's name is cut to one language; a municipality's inhabitants are the sum of its postal areas and its centre their inhabitant-weighted mean; a small area is joined to its municipality, or to the nearest large enough.",
    },
    fi: {
      source: `Paavo, postinumeroalueittainen avoin tieto ${year}, ja Kunnat ${year} (1:4 500 000), Tilastokeskus. Aineisto on ladattu Tilastokeskuksen rajapintapalvelusta ${day} lisenssillä ${LICENCE}, ${LICENCE_URL}.`,
      changes:
        "Kuutin tekemät muutokset: käytössä ovat vain koodit, nimet, kunnat, asukasluvut ja keskipisteet; kunnan nimi on rajattu yhdelle kielelle; kunnan asukasluku on sen postinumeroalueiden summa ja keskipiste niiden asukasluvuilla painotettu keskiarvo; pieni alue on yhdistetty kuntaansa tai lähimpään riittävän suureen kuntaan.",
    },
  };
}

const swedish = (place: { fi: string; sv: string }) => (place.sv === place.fi ? "" : place.sv);

const postalRow = (area: Area) => `${area.code}|${area.fi}|${swedish(area)}`;
const areaRow = (area: Area) =>
  `${area.code}|${area.municipality}|${area.x}|${area.y}|${area.inhabitants}`;
const municipalityRow = (place: Municipality) =>
  `${place.code}|${place.fi}|${swedish(place)}|${place.x}|${place.y}|${place.inhabitants}|${place.alwaysTown ? 1 : ""}`;

/** One property of the credit as Biome lays it out, so `pnpm lint` passes a fresh file untouched. */
function property(indent: string, key: string, value: string | number): string {
  const text = JSON.stringify(value);
  const line = `${indent}${key}: ${text},`;
  return line.length <= LINE ? line : `${indent}${key}:\n${indent}  ${text},`;
}

function header(credit: Credit): string {
  return [
    `// Generated by \`pnpm places\` (scripts/places.ts, ADR-061 §4); never edited by hand.`,
    `// ${credit.en.source}`,
    `// ${credit.en.changes}`,
    "// Not under the repository's licence: packages/schema/src/postal-areas.NOTICE.md.",
  ].join("\n");
}

function postalFile(areas: Area[], credit: Credit): string {
  const words = ({ source, changes }: Words) =>
    `${property("    ", "source", source)}\n${property("    ", "changes", changes)}`;
  return `${header(credit)}

/** Who the list is from, what was done to it and on what terms: the licences screen and the API image's notices say this. */
export const POSTAL_AREAS_CREDIT = {
${property("  ", "year", credit.year)}
${property("  ", "date", credit.date)}
${property("  ", "licence", credit.licence)}
${property("  ", "licenceUrl", credit.licenceUrl)}
${property("  ", "sourceUrl", credit.sourceUrl)}
  en: {
${words(credit.en)}
  },
  fi: {
${words(credit.fi)}
  },
} as const;

/** One row per postal area, by code: code|fi|sv, sv empty where it equals fi. */
export const POSTAL_AREA_ROWS = \`${areas.map(postalRow).join("\n")}\`;
`;
}

function placesFile(areas: Area[], municipalities: Municipality[], credit: Credit): string {
  return `${header(credit)}

/** One row per postal area, by code: code|municipality|x|y|inhabitants; x and y in ETRS-TM35FIN metres, inhabitants -1 where Statistics Finland hides the figure. */
export const PLACE_AREA_ROWS = \`${areas.map(areaRow).join("\n")}\`;

/** One row per municipality, by code: code|fi|sv|x|y|inhabitants|town; sv empty where it equals fi, town 1 for one that counts as a town at any size. */
export const PLACE_MUNICIPALITY_ROWS = \`${municipalities.map(municipalityRow).join("\n")}\`;
`;
}

function noticeFile(credit: Credit): string {
  return `# The postal list: source and terms

\`postal-areas.generated.ts\` here and \`apps/api/src/pond/places.generated.ts\` are made by \`pnpm places\` (\`scripts/places.ts\`, ADR-061 §4) from Statistics Finland's open data. They are not under the repository's licence (\`LICENSE\`) but under [${credit.licence}](${credit.licenceUrl}), and Statistics Finland has not endorsed Kuutti or this use of them.

${credit.en.source}

${credit.en.changes}

${credit.fi.source}

${credit.fi.changes}

The layers are \`postialue:pno_tilasto_${credit.year}\` and \`tilastointialueet:kunta4500k_${credit.year}\` of the service at ${credit.sourceUrl}.
`;
}

type Written = { areas: number; municipalities: number; files: Record<string, number> };

/** Reads both layers and writes the three files, in that order: a refusal leaves the old files as they were. */
async function build(get: Get, year: number, date: string, root: string): Promise<Written> {
  const areas = areasFrom(await readLayer(get, areaLayer(year)));
  const municipalities = municipalitiesFrom(await readLayer(get, municipalityLayer(year)), areas);
  const credit = creditOf(year, date);
  const files: [string, string][] = [
    [POSTAL_FILE, postalFile(areas, credit)],
    [NOTICE_FILE, noticeFile(credit)],
    [PLACES_FILE, placesFile(areas, municipalities, credit)],
  ];
  for (const [file, text] of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return {
    areas: areas.length,
    municipalities: municipalities.length,
    files: Object.fromEntries(files.map(([file]) => [file, statSync(join(root, file)).size])),
  };
}

/** The command line: a flag without a usable value, given twice or unknown is refused (#235). */
function parseYear(argv: string[], now: Date): number {
  const args = argv.filter((arg) => arg !== "--");
  let year: number | undefined;
  for (let at = 0; at < args.length; at++) {
    const [flag = "", inline] = (args[at] ?? "").split(/=(.*)/s);
    if (flag !== "--year") throw new Error(`unknown argument ${flag}: only --year is taken`);
    const value = inline ?? args[++at];
    if (value === undefined || !/^20\d\d$/.test(value)) {
      throw new Error("--year takes a year, such as 2026");
    }
    if (year !== undefined) throw new Error("--year is given twice");
    year = Number(value);
  }
  return year ?? now.getFullYear();
}

async function selfTest(): Promise<void> {
  const failures: string[] = [];
  const same = (name: string, got: unknown, expected: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    }
  };
  const area = (fields: Field = {}): Field => ({
    postinumeroalue: "00100",
    nimi: "Helsinki keskusta - Etu-Töölö",
    namn: "Helsingfors centrum - Främre Tölö",
    kunta: "091",
    euref_x: 384979,
    euref_y: 6672361,
    he_vakiy: 18492,
    ...fields,
  });
  const fixture = {
    areas: [
      // Out of order on purpose: the files are sorted, so a year's diff is what changed.
      area({ postinumeroalue: "22100", nimi: "Maarianhamina", namn: "Mariehamn", kunta: "478" }),
      area(),
      area({ postinumeroalue: "00230", nimi: "Pasila", namn: "Pasila", he_vakiy: 0 }),
      area({ postinumeroalue: "00990", euref_x: 390000, euref_y: 6680000, he_vakiy: 6164 }),
      area({ postinumeroalue: "02700", kunta: "049", he_vakiy: -1, euref_x: 999 }),
      area({ postinumeroalue: "83960", nimi: "Koli", namn: "Koli", kunta: "422", he_vakiy: -1 }),
      area({
        postinumeroalue: "83940",
        nimi: "Vuonislahti",
        namn: "Vuonislahti",
        kunta: "422",
        euref_x: 384981,
        he_vakiy: -1,
      }),
    ],
    municipalities: [
      { kunta: "478", nimi: "Maarianhamina - Mariehamn", namn: "Mariehamn" },
      { kunta: "091", nimi: "Helsinki", namn: "Helsingfors" },
      { kunta: "049", nimi: "Espoo", namn: "Esbo" },
      { kunta: "422", nimi: "Lieksa", namn: "Lieksa" },
    ],
  };
  const collection = (rows: Field[]) =>
    JSON.stringify({
      type: "FeatureCollection",
      features: rows.map((properties, id) => ({ id, properties })),
      numberMatched: rows.length,
    });
  /** The stand-in of the service: anything but the two layers of the year is a failure of the test. */
  const serve =
    (areas: Field[], municipalities: Field[] = fixture.municipalities): Get =>
    async (url) => {
      const { origin, pathname, searchParams } = new URL(url);
      const layer = searchParams.get("typeName");
      same("the host read", `${origin}${pathname}`.startsWith(`${WFS}/`), true);
      if (layer === "postialue:pno_tilasto_2026") return new Response(collection(areas));
      if (layer === "tilastointialueet:kunta4500k_2026") {
        return new Response(collection(municipalities));
      }
      return new Response("unknown layer", { status: 400 });
    };
  const root = mkdtempSync(join(tmpdir(), "kuutti-places-"));
  const refused = async (name: string, get: Get, words: string) => {
    let message = "not refused";
    try {
      await build(get, 2026, "2026-10-31", join(root, "refused"));
    } catch (error) {
      message = (error as Error).message;
    }
    same(`${name}: the refusal`, message.includes(words) ? words : message, words);
    let wrote = false;
    try {
      wrote = statSync(join(root, "refused", POSTAL_FILE)).isFile();
    } catch {}
    same(`${name}: writes nothing`, wrote, false);
  };

  try {
    const written = await build(serve(fixture.areas), 2026, "2026-10-02", root);
    same("the rows counted", [written.areas, written.municipalities], [7, 4]);
    same("the files", Object.keys(written.files), [POSTAL_FILE, NOTICE_FILE, PLACES_FILE]);

    // What it wrote loads as a module and reads back row by row: the test of the template strings.
    const load = (file: string) => import(pathToFileURL(join(root, file)).href);
    const postal = await load(POSTAL_FILE);
    const places = await load(PLACES_FILE);
    same(
      "the postal rows, sorted, Swedish only where it differs",
      postal.POSTAL_AREA_ROWS.split("\n"),
      [
        "00100|Helsinki keskusta - Etu-Töölö|Helsingfors centrum - Främre Tölö",
        "00230|Pasila|",
        "00990|Helsinki keskusta - Etu-Töölö|Helsingfors centrum - Främre Tölö",
        "02700|Helsinki keskusta - Etu-Töölö|Helsingfors centrum - Främre Tölö",
        "22100|Maarianhamina|Mariehamn",
        "83940|Vuonislahti|",
        "83960|Koli|",
      ],
    );
    same("the areas, a hidden figure as it came", places.PLACE_AREA_ROWS.split("\n"), [
      "00100|091|384979|6672361|18492",
      "00230|091|384979|6672361|0",
      "00990|091|390000|6680000|6164",
      "02700|049|999|6672361|-1",
      "22100|478|384979|6672361|18492",
      "83940|422|384981|6672361|-1",
      "83960|422|384979|6672361|-1",
    ]);
    same(
      "the municipalities: names in one language, the sum, the weighted mean, a mean with nobody to weigh by, the town's mark",
      places.PLACE_MUNICIPALITY_ROWS.split("\n"),
      [
        "049|Espoo|Esbo|999|6672361|0|",
        "091|Helsinki|Helsingfors|386234|6674271|24656|",
        "422|Lieksa||384980|6672361|0|",
        "478|Maarianhamina|Mariehamn|384979|6672361|18492|1",
      ],
    );
    same(
      "the credit's date and year",
      [postal.POSTAL_AREAS_CREDIT.date, postal.POSTAL_AREAS_CREDIT.year],
      ["2026-10-02", 2026],
    );
    same(
      "the credit's day in words",
      postal.POSTAL_AREAS_CREDIT.en.source.includes(" on 2.10.2026, licence CC BY 4.0, "),
      true,
    );
    same(
      "the credit in Finnish",
      postal.POSTAL_AREAS_CREDIT.fi.source.includes("Tilastokeskus"),
      true,
    );
    for (const file of [POSTAL_FILE, PLACES_FILE, NOTICE_FILE]) {
      const text = readFileSync(join(root, file), "utf8");
      same(`${file} credits the source`, text.includes("Statistics Finland"), true);
      same(`${file} names the licence`, text.includes(LICENCE_URL), true);
      same(`${file} says what was changed`, text.includes("Changed by Kuutti"), true);
    }
    same(
      "the credit's object is laid out for the line width",
      readFileSync(join(root, POSTAL_FILE), "utf8").includes('    source:\n      "Paavo,'),
      true,
    );

    for (const [name, hostile] of [
      ["a backtick", "Kallio`;process.exit(1);//"],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a fetched name that would run as code is the case.
      ["an interpolation", "Kallio ${process.exit(1)}"],
      ["a backslash", "Kallio\\"],
      ["the separator", "Kallio|00100"],
      ["markup", "<b>Kallio</b>"],
      ["nothing", " "],
      ["a name too long", "K".repeat(NAME_MAX + 1)],
      // Attacks (#380): a name that would change the file it lands in, or how it is read, is
      // written; their control is the fixture's own names, written and read back above.
      ["a dollar sign", "Kallio $HOME"],
      ["a mark that turns the reading order", "Kallio\u202Eoillak"],
    ] as const) {
      await refused(`an area with ${name}`, serve([area({ nimi: hostile })]), "a name this list");
      await refused(
        `a municipality with ${name}`,
        serve([area()], [{ kunta: "091", nimi: "Helsinki", namn: hostile }]),
        "a name this list",
      );
    }
    same(
      "a line break is only a space",
      nameOf("Kallio\nKruununhaka", "a test"),
      "Kallio Kruununhaka",
    );
    same("a double space goes", nameOf("Norra  Nordsjö", "a test"), "Norra Nordsjö");
    for (const [name, change, words] of [
      ["a short code", { postinumeroalue: "0010" }, "a code of 5 digits"],
      ["a code as a number", { postinumeroalue: 100 }, "a code of 5 digits"],
      ["a municipality as text", { kunta: "Helsinki" }, "a code of 3 digits"],
      ["a coordinate as text", { euref_x: "384979" }, "a whole number"],
      ["a fraction of a metre", { euref_y: 6672361.5 }, "a whole number"],
      ["degrees for metres", { euref_y: 60 }, "out of bounds"],
      ["no inhabitants field", { he_vakiy: null }, "a whole number"],
      ["minus two inhabitants", { he_vakiy: -2 }, "out of bounds"],
      // Attacks (#380): a code that only looks like five digits is taken; their control is the
      // fixture's own codes, written and read back above.
      [
        "a code in digits of another script",
        { postinumeroalue: "００１００" },
        "a code of 5 digits",
      ],
      ["a code with a line break after it", { postinumeroalue: "00100\n" }, "a code of 5 digits"],
    ] as const) {
      await refused(name, serve([area(change)]), words);
    }
    await refused("a code twice", serve([area(), area()]), "twice");
    await refused(
      "an area of a municipality with no name",
      serve(
        [area(), area({ postinumeroalue: "00200", kunta: "999" })],
        [fixture.municipalities[1] ?? {}],
      ),
      "no name",
    );
    await refused(
      "a municipality with no area",
      serve(
        [area()],
        [
          { kunta: "091", nimi: "Helsinki", namn: "Helsingfors" },
          { kunta: "049", nimi: "Espoo", namn: "Esbo" },
        ],
      ),
      "no postal area",
    );
    await refused(
      "a municipality twice",
      serve(
        [area()],
        [
          { kunta: "091", nimi: "Helsinki", namn: "Helsingfors" },
          { kunta: "091", nimi: "Helsinki", namn: "Helsingfors" },
        ],
      ),
      "a municipality twice",
    );
    await refused(
      "a list cut short",
      async () =>
        new Response(JSON.stringify({ features: [{ properties: area() }], numberMatched: 3018 })),
      "1 rows of 3018",
    );
    await refused(
      "an empty list",
      async () => new Response(JSON.stringify({ features: [], numberMatched: 0 })),
      "0 rows of 0",
    );
    await refused("no JSON", async () => new Response("<html>"), "did not answer in JSON");
    await refused("a refused layer", async () => new Response("", { status: 400 }), "answered 400");

    const now = new Date("2026-10-31T12:00:00Z");
    same("the year by default", parseYear([], now), 2026);
    same("the year asked", parseYear(["--", "--year", "2025"], now), 2025);
    same("the year asked, joined", parseYear(["--year=2025"], now), 2025);
    for (const [args, words] of [
      [["--year"], "--year takes a year"],
      [["--year", "26"], "--year takes a year"],
      [["--year="], "--year takes a year"],
      [["--year", "2026/../x"], "--year takes a year"],
      [["--year", "2026", "--year", "2025"], "--year is given twice"],
      [["--force"], "unknown argument --force"],
      [["2026"], "unknown argument 2026"],
      // Attacks (#380): a year that would reach another layer or another year's is read; their
      // control is "the year asked", above.
      [["--year", "2026&typeName=x"], "--year takes a year"],
      [["--year", "2026\n"], "--year takes a year"],
      [["--year", "２０２６"], "--year takes a year"],
      [["--year=2026", "--year=2025"], "--year is given twice"],
      [["--YEAR", "2025"], "unknown argument --YEAR"],
    ] as const) {
      let message = "not refused";
      try {
        parseYear([...args], now);
      } catch (error) {
        message = (error as Error).message;
      }
      same(`the command line ${args.join(" ")}`, message.includes(words) ? words : message, words);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  for (const failure of failures) console.error(`✖ self-test, ${failure}`);
  if (failures.length > 0) process.exit(1);
  console.log("✔ places self-test: the lists, the refusals, the credit, the command line");
  process.exit(0);
}

if (process.argv.includes("--self-test")) await selfTest();

try {
  const year = parseYear(process.argv.slice(2), new Date());
  const today = new Date().toISOString().slice(0, 10);
  const written = await build(fetch, year, today, ROOT);
  console.log(
    `✔ places ${year}: ${written.areas} postal areas and ${written.municipalities} municipalities`,
  );
  for (const [file, bytes] of Object.entries(written.files)) {
    console.log(`  ${file}: ${(bytes / 1000).toFixed(1)} kB`);
  }
} catch (error) {
  console.error(`✖ places: ${(error as Error).message}`);
  process.exit(1);
}
