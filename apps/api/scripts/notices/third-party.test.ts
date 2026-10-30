import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { collectNotices, type Notices, shippedFilesOf, textKey } from "@kuutti/notices";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bundledFiles,
  checkLibvips,
  imgDirs,
  installedLibvips,
  LIBVIPS,
  type LibvipsPart,
  render,
  UPSTREAM,
  writeNotices,
} from "./third-party.ts";

// The API image's THIRD_PARTY_NOTICES (#416). How a licence file reads is
// @kuutti/notices' own test; these are the image's part: what the build
// bundled, the @img packages beside it, the file's form, and the table of
// upstream licences against the install.

const API = resolve(import.meta.dirname, "../..");
const ROOT = resolve(API, "../..");
const MIT = "Permission is hereby granted, free of charge, to any person obtaining a copy.";

/** A libvips part of one library, with texts of its own and one it shares with the packages. */
const PART: LibvipsPart = {
  package: "@img/sharp-libvips-linux-arm64",
  version: "1.3.4",
  build: "https://github.com/lovell/sharp-libvips/tree/v1.3.4",
  versions: { vips: "8.18.7", png: "1.6.58" },
  lgpl: "lgpl",
  gpl: "gpl",
  mpl2: "mpl2",
  libraries: [
    {
      name: "libvips",
      version: "8.18.7",
      license: "LGPL-2.1-or-later, used under LGPL-3.0",
      source: [
        "https://example.invalid/vips-8.18.7.tar.xz",
        "https://example.invalid/soversion.patch",
      ],
      licences: [
        {
          file: null,
          from: "https://www.gnu.org/licenses/lgpl-3.0.txt",
          copyright: [],
          text: "lgpl",
        },
      ],
    },
    {
      name: "libpng",
      version: "1.6.58",
      license: "MIT",
      source: ["https://example.invalid/libpng-1.6.58.tar.gz"],
      licences: [
        {
          file: null,
          from: "https://example.invalid/LICENSE",
          copyright: ["Copyright (c) PNG"],
          text: "mit",
        },
      ],
    },
  ],
  texts: { lgpl: "LESSER", gpl: "GENERAL", mpl2: "MOZILLA", mit: MIT },
};

let scratch = "";
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "kuutti-notices-"));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A package directory under `root` with its package.json and files. */
function pkg(root: string, dir: string, manifest: object, files: Record<string, string> = {}) {
  const at = join(root, dir);
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "package.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(at, name), text);
  return at;
}

describe("the files a build bundled", () => {
  it("are every input of every output that put code into it, from the build's directory", () => {
    const metafile = {
      outputs: {
        "dist/index.js": {
          inputs: {
            "../../node_modules/pg/lib/index.js": { bytesInOutput: 120 },
            "node_modules/ws/lib/websocket.js": { bytesInOutput: 4 },
            "../../node_modules/bowser/es5.js": { bytesInOutput: 0 },
          },
        },
        "dist/index.js.map": { inputs: {} },
        "dist/demo-assets.js": { inputs: { "src/lib/db.ts": { bytesInOutput: 9 } } },
      },
    };
    expect(bundledFiles(metafile, "/repo/apps/api")).toEqual([
      "/repo/node_modules/pg/lib/index.js",
      "/repo/apps/api/node_modules/ws/lib/websocket.js",
      "/repo/apps/api/src/lib/db.ts",
    ]);
  });
});

describe("the packages of node_modules/@img", () => {
  it("are sharp's addon and colour, libvips' package left to its own part", () => {
    const root = join(scratch, "img");
    for (const name of ["colour", "sharp-linux-arm64", "sharp-libvips-linux-arm64"]) {
      mkdirSync(join(root, "node_modules", "@img", name), { recursive: true });
    }
    writeFileSync(join(root, "node_modules", "@img", "README"), "");
    expect(imgDirs(root).sort()).toEqual([
      join(root, "node_modules", "@img", "colour"),
      join(root, "node_modules", "@img", "sharp-linux-arm64"),
    ]);
  });

  it("are none where nothing installed them", () => {
    expect(imgDirs(join(scratch, "nowhere"))).toEqual([]);
  });
});

describe("the notices file", () => {
  const notices: Notices = {
    texts: {
      mit: MIT,
      apache: "Apache License\nVersion 2.0",
      list: "Name: debug",
      note: "Orchestrion-JS",
    },
    packages: [
      {
        name: "@scope/a",
        version: "1.0.0",
        license: "MIT",
        // The app's list shows it (#512); the file below never does.
        provider: "scope",
        licences: [
          {
            file: "LICENSE",
            copyright: ["Copyright (c) 2020 A", "All rights reserved."],
            text: "mit",
          },
        ],
        notices: [],
      },
      {
        name: "b",
        version: "2.0.0",
        license: "Apache-2.0",
        provider: "Bee Oy",
        licences: [{ file: "LICENSE.md", copyright: [], text: "apache" }],
        notices: ["note"],
      },
      {
        name: "c",
        version: "3.0.0",
        license: "MIT",
        provider: null,
        licences: [
          {
            file: null,
            copyright: ["Copyright (c) 2012 C"],
            text: "mit",
            from: "https://example.invalid/LICENSE",
          },
          { file: "build/THIRD-PARTY-LICENSES.txt", copyright: [], text: "list" },
        ],
        notices: [],
      },
    ],
  };

  it("says what it is, lists each package with its lines and its texts' numbers, then libvips' part, then each text once", () => {
    const file = render(notices, PART);
    const rule = "=".repeat(80);
    expect(
      file.startsWith(
        "THIRD-PARTY NOTICES OF THE KUUTTI API IMAGE\n\nThis image runs the Kuutti API",
      ),
    ).toBe(true);
    const packages = file.slice(
      file.indexOf(`${rule}\n@scope/a`),
      file.indexOf(`${rule}\nLIBVIPS`),
    );
    expect(packages).toBe(
      [
        rule,
        "@scope/a 1.0.0 (MIT)",
        "",
        "Copyright (c) 2020 A",
        "All rights reserved.",
        "Licence: text 1 below (the package's LICENSE)",
        "",
        rule,
        "b 2.0.0 (Apache-2.0)",
        "",
        "Licence: text 2 below (the package's LICENSE.md)",
        "",
        "Notice: text 3 below (the package's NOTICE)",
        "",
        rule,
        "c 3.0.0 (MIT)",
        "",
        "Copyright (c) 2012 C",
        "Licence: text 1 below (the package ships no licence file; from https://example.invalid/LICENSE)",
        "",
        "Licence: text 4 below (the package's build/THIRD-PARTY-LICENSES.txt)",
        "",
        "",
      ].join("\n"),
    );
    const intro = file.slice(
      file.indexOf(`${rule}\nLIBVIPS`),
      file.indexOf(`${rule}\nlibvips 8.18.7`),
    );
    expect(intro).toContain(
      "node_modules/@img/sharp-libvips-linux-arm64 1.3.4 holds libvips 8.18.7",
    );
    expect(intro).toContain("sharp's addon (node_modules/@img/sharp-linux-arm64) loads as the API");
    expect(intro).toContain(
      "that\nlicence is text 5 below, and the GNU General Public License 3.0",
    );
    expect(intro).toContain("is text 6. The shared library can be\nreplaced");
    expect(intro).toContain("https://github.com/lovell/sharp-libvips/tree/v1.3.4,\n");
    expect(intro).toContain("2.0 (text 7) under that licence");
    expect(intro).toContain(
      "is also copied to\nhttps://github.com/kuutti-ry/kuutti-app/releases/tag/sources-sharp-libvips-1.3.4,\nin case",
    );
    expect(
      file.slice(file.indexOf(`${rule}\nlibvips 8.18.7`), file.indexOf(`${rule}\nText 1\n`)),
    ).toBe(
      [
        rule,
        "libvips 8.18.7 (LGPL-2.1-or-later, used under LGPL-3.0)",
        "Source: https://example.invalid/vips-8.18.7.tar.xz",
        "Source: https://example.invalid/soversion.patch",
        "",
        "Licence: text 5 below (from https://www.gnu.org/licenses/lgpl-3.0.txt)",
        "",
        rule,
        "libpng 1.6.58 (MIT)",
        "Source: https://example.invalid/libpng-1.6.58.tar.gz",
        "",
        "Copyright (c) PNG",
        "Licence: text 1 below (from https://example.invalid/LICENSE)",
        "",
        "",
      ].join("\n"),
    );
    expect(file.slice(file.indexOf(`${rule}\nText 1\n`))).toBe(
      [
        `${rule}\nText 1\n\n${MIT}`,
        `${rule}\nText 2\n\nApache License\nVersion 2.0`,
        `${rule}\nText 3\n\nOrchestrion-JS`,
        `${rule}\nText 4\n\nName: debug`,
        `${rule}\nText 5\n\nLESSER`,
        `${rule}\nText 6\n\nGENERAL`,
        `${rule}\nText 7\n\nMOZILLA`,
      ].join("\n\n") + "\n",
    );
  });

  it("is the header, libvips' part and its texts for no packages", () => {
    const file = render({ texts: {}, packages: [] }, { ...PART, libraries: [] });
    expect(file).toMatch(
      /then the texts, each once, as their\nfiles have them\.\n\n={80}\nLIBVIPS/,
    );
    expect(file).toMatch(/Text 3\n\nMOZILLA\n$/);
  });
});

describe("the libvips the install holds", () => {
  const installAt = (root: string, version: string, versions: object) => {
    pkg(
      root,
      "node_modules/@img/sharp-libvips-linux-arm64",
      { name: "@img/sharp-libvips-linux-arm64", version },
      {
        "versions.json": JSON.stringify(versions),
      },
    );
    mkdirSync(join(root, "node_modules", "@img", "colour"), { recursive: true });
  };

  it("is the platform's package with its versions, or none", () => {
    const root = join(scratch, "vips-installed");
    installAt(root, "1.3.4", PART.versions);
    expect(installedLibvips(root)).toEqual({
      name: "@img/sharp-libvips-linux-arm64",
      version: "1.3.4",
      versions: PART.versions,
    });
    expect(installedLibvips(join(scratch, "vips-none"))).toBeNull();
    mkdirSync(join(scratch, "vips-empty", "node_modules", "@img", "colour"), { recursive: true });
    expect(installedLibvips(join(scratch, "vips-empty"))).toBeNull();
  });

  it("must be the one the part was gathered from, in its version and its libraries' versions", () => {
    const same = join(scratch, "vips-same");
    installAt(same, "1.3.4", { png: "1.6.58", vips: "8.18.7" });
    expect(() => checkLibvips(PART, same)).not.toThrow();
    const newer = join(scratch, "vips-newer");
    installAt(newer, "1.3.5", PART.versions);
    expect(() => checkLibvips(PART, newer)).toThrow(
      "notices/libvips.json is of @img/sharp-libvips-linux-arm64 1.3.4, the install holds @img/sharp-libvips-linux-arm64 1.3.5: gather its libraries' texts again",
    );
    const moved = join(scratch, "vips-moved");
    installAt(moved, "1.3.4", { ...PART.versions, png: "1.6.59" });
    expect(() => checkLibvips(PART, moved)).toThrow(
      "the install holds @img/sharp-libvips-linux-arm64 1.3.4",
    );
    expect(() => checkLibvips(PART, join(scratch, "vips-none"))).toThrow(
      "the install holds no libvips",
    );
  });

  it("is the one notices/libvips.json was gathered from, every text it names there", () => {
    const part: LibvipsPart = JSON.parse(readFileSync(LIBVIPS, "utf8"));
    expect(() => checkLibvips(part, ROOT)).not.toThrow();
    const named = [
      part.lgpl,
      part.gpl,
      part.mpl2,
      ...part.libraries.flatMap((l) => l.licences.map((x) => x.text)),
    ];
    expect(named.filter((key) => !part.texts[key])).toEqual([]);
    expect(Object.keys(part.texts).filter((key) => !named.includes(key))).toEqual([]);
    expect(part.texts[part.lgpl]).toMatch(/GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/);
    expect(part.texts[part.gpl]).toMatch(/GNU GENERAL PUBLIC LICENSE\s+Version 3/);
    expect(part.libraries.filter((l) => l.source.length === 0 || l.licences.length === 0)).toEqual(
      [],
    );
  });
});

describe("writing the notices of a build", () => {
  it("reads the metafile and @img, writes the file, removes the metafile and counts what it holds", () => {
    const root = join(scratch, "build");
    const api = join(root, "apps", "api");
    pkg(
      root,
      "node_modules/hono",
      { name: "hono", version: "4.0.0", license: "MIT" },
      {
        LICENSE: `MIT License\n\nCopyright (c) 2021 Yusuke Wada\n\n${MIT}`,
      },
    );
    pkg(
      root,
      "node_modules/@img/colour",
      { name: "@img/colour", version: "1.1.0", license: "MIT" },
      {
        "LICENSE.md": `Copyright (c) 2012 Heather Arthur\n\n${MIT}`,
      },
    );
    pkg(
      root,
      "node_modules/@img/sharp-libvips-linux-arm64",
      { name: "@img/sharp-libvips-linux-arm64", version: "1.3.4" },
      {
        "versions.json": JSON.stringify(PART.versions),
      },
    );
    mkdirSync(join(api, "dist"), { recursive: true });
    const paths = {
      metafile: join(api, "dist", "metafile-esm.json"),
      output: join(api, "dist", "THIRD_PARTY_NOTICES"),
      libvips: join(scratch, "libvips.json"),
      api,
      root,
    };
    // libpng's text by the key the packages' MIT text has, so the two are one.
    const mit = textKey(MIT);
    const part = {
      ...PART,
      libraries: PART.libraries.map((l) => ({
        ...l,
        licences: l.licences.map((x) => (x.text === "mit" ? { ...x, text: mit } : x)),
      })),
      texts: { lgpl: "LESSER", gpl: "GENERAL", mpl2: "MOZILLA", [mit]: MIT },
    };
    writeFileSync(paths.libvips, JSON.stringify(part));
    writeFileSync(
      paths.metafile,
      JSON.stringify({
        outputs: {
          "dist/index.js": {
            inputs: { "../../node_modules/hono/dist/index.js": { bytesInOutput: 1 } },
          },
        },
      }),
    );
    expect(writeNotices(paths, {})).toEqual({ packages: 2, libraries: 2 });
    const file = readFileSync(paths.output, "utf8");
    expect(file).toContain(
      "@img/colour 1.1.0 (MIT)\n\nCopyright (c) 2012 Heather Arthur\nLicence: text 1",
    );
    expect(file).toContain("hono 4.0.0 (MIT)\n\nCopyright (c) 2021 Yusuke Wada\nLicence: text 1");
    // libpng's text is the packages' MIT text, numbered once.
    expect(file).toContain("Copyright (c) PNG\nLicence: text 1 below");
    expect(file.match(/^Text \d+$/gm)).toHaveLength(4);
    expect(existsSync(paths.metafile)).toBe(false);
  });

  it("fails on a bundled package with no licence text, and keeps the metafile", () => {
    const root = join(scratch, "bare");
    const api = join(root, "apps", "api");
    pkg(root, "node_modules/bare", { name: "bare", version: "0.0.1", license: "MIT" });
    mkdirSync(join(api, "dist"), { recursive: true });
    const metafile = join(api, "dist", "metafile-esm.json");
    writeFileSync(
      metafile,
      JSON.stringify({
        outputs: {
          "dist/index.js": { inputs: { "../../node_modules/bare/index.js": { bytesInOutput: 1 } } },
        },
      }),
    );
    pkg(
      root,
      "node_modules/@img/sharp-libvips-linux-arm64",
      { name: "@img/sharp-libvips-linux-arm64", version: "1.3.4" },
      { "versions.json": JSON.stringify(PART.versions) },
    );
    const libvips = join(root, "libvips.json");
    writeFileSync(libvips, JSON.stringify(PART));
    const paths = {
      metafile,
      output: join(api, "dist", "THIRD_PARTY_NOTICES"),
      libvips,
      api,
      root,
    };
    expect(() => writeNotices(paths, {})).toThrow("no licence text for bare@0.0.1");
    expect(existsSync(paths.output)).toBe(false);
    expect(existsSync(metafile)).toBe(true);
  });
});

describe("the table of upstream licences, against the API's install (#416)", () => {
  /** The installed copy of a package: the API's own node_modules first, then the workspace's. */
  const dirOf = (name: string) =>
    [join(API, "node_modules", name), join(ROOT, "node_modules", name)].find((dir) =>
      existsSync(join(dir, "package.json")),
    );
  const named = Object.entries(UPSTREAM).flatMap(([name, rows]) => [
    name,
    ...rows.flatMap((row) => ("like" in row ? [row.like] : [])),
  ]);

  it("names packages that are installed, the ones with rows shipping no licence file of their own", () => {
    expect(named.filter((name) => !dirOf(name))).toEqual([]);
    expect(
      Object.keys(UPSTREAM).filter(
        (name) => shippedFilesOf(dirOf(name) as string).licences.length > 0,
      ),
    ).toEqual([]);
  });

  it("gives every row a text: its file, or the one licence of the package it names under the same licence", () => {
    const notices = collectNotices(new Set(named.map((name) => dirOf(name) as string)), UPSTREAM);
    for (const name of Object.keys(UPSTREAM)) {
      const own = notices.packages.find((p) => p.name === name);
      expect([name, own?.licences.length]).toEqual([name, UPSTREAM[name]?.length]);
      for (const licence of own?.licences ?? [])
        expect(notices.texts[licence.text]?.length).toBeGreaterThan(100);
    }
  });

  it("pins every address to a commit or a tag, never a branch", () => {
    const addresses = Object.values(UPSTREAM).flatMap((rows) =>
      rows.flatMap((row) => ("from" in row ? [row.from] : [])),
    );
    expect(
      addresses.filter(
        (from) =>
          !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/blob\/([0-9a-f]{40}|v?\d[\w.-]*)\//.test(
            from,
          ),
      ),
    ).toEqual([]);
  });
});
