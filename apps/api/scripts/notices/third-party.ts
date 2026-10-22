/**
 * THIRD_PARTY_NOTICES of the API image (#416): the copyright lines, licence
 * texts and NOTICE files of every package the image carries, which the
 * licences of most of them ask to go with every copy. The image is public on
 * GHCR, so it is a copy.
 *
 * What it carries is what tsup bundled into dist, and the packages of
 * node_modules/@img the Dockerfile copies beside it (sharp's addon and
 * libvips, which a bundler cannot inline). The bundled files come from
 * esbuild's metafile (tsup.config.ts writes it), not from the source maps:
 * esbuild composes those with the packages' own maps, so drizzle-orm's
 * sources there sit in a node_modules/src that is no package (22/10/2026).
 * The texts are read from the directory the build resolved
 * (@kuutti/notices), so a package installed twice gives the copy that
 * shipped. libvips and the libraries built into it are their own part
 * (notices/libvips.json), since what LGPL-3.0 asks of them is more than a
 * notice.
 *
 * scripts/notices.ts runs it after tsup.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  collectNotices,
  type Licence,
  type Notices,
  shippedPackageDirs,
  type Upstream,
} from "@kuutti/notices";

const API = resolve(import.meta.dirname, "../..");
const ROOT = resolve(API, "../..");
const METAFILE = join(API, "dist", "metafile-esm.json");
const OUTPUT = join(API, "dist", "THIRD_PARTY_NOTICES");
export const LIBVIPS = join(API, "notices", "libvips.json");

const HONO = {
  copyright: ["Copyright (c) 2022 - present, Yusuke Wada and Hono contributors"],
  like: "@hono/node-server",
  from: "https://github.com/honojs/middleware/blob/a8e2af4d857aa7fabf290cdf6f67307678e50409/LICENSE",
};
// The repository's root licence; @aws-sdk/core ships it byte for byte, its
// appendix naming Amazon.
const AWS = {
  copyright: [],
  like: "@aws-sdk/core",
  from: "https://github.com/aws/aws-sdk-js-v3/blob/663046d58796f32069e5198f95a3070b2f5ef969/LICENSE",
};
// The root licence's MIT part. Its last paragraph is about the Sentry CLI,
// which the bundle does not carry.
const SENTRY = {
  copyright: ["Copyright (c) 2012 Functional Software, Inc. dba Sentry"],
  like: "@sentry/core",
  from: "https://github.com/getsentry/sentry-javascript/blob/5779ab0b88db83adb1157a9881f554403e652018/LICENSE",
};

/**
 * The bundled packages that carry no licence file of their own (#416), each
 * with the upstream licences that cover what it ships: the copyright lines,
 * the address they were read at, pinned to the commit or tag of the version
 * read (22/10/2026), and the bundled package whose file has upstream's text.
 * A monorepo's packages fall under its root licence; pg-types and pgpass
 * keep theirs in the README. @sentry/server-runtime-injection inlines the
 * code of the packages it vendored, whose texts and one NOTICE it lists in
 * a file of its own. A row nothing needs fails the build, as does a package
 * missing from here.
 */
export const UPSTREAM: Readonly<Record<string, readonly Upstream[]>> = {
  "@aws-sdk/credential-provider-http": [AWS],
  "@aws-sdk/credential-provider-login": [AWS],
  "@aws-sdk/nested-clients": [AWS],
  "@hono/swagger-ui": [HONO],
  "@hono/zod-openapi": [HONO],
  "@hono/zod-validator": [HONO],
  "@sentry/server-runtime-injection": [SENTRY, { file: "build/THIRD-PARTY-LICENSES.txt" }],
  "@sentry/server-utils": [SENTRY],
  blurhash: [
    {
      copyright: ["Copyright (c) 2018 Wolt Enterprises"],
      like: "pg",
      from: "https://github.com/woltapp/blurhash/blob/cb151cab5b7d9cd3eef624e12e30381c6d292f0d/License.md",
    },
  ],
  // Upstream names no holder: the appendix is the template's.
  "drizzle-orm": [
    {
      copyright: [],
      like: "@opentelemetry/api",
      from: "https://github.com/drizzle-team/drizzle-orm/blob/15454dbe49d827c6081f3d0231e2e7985e517295/LICENSE",
    },
  ],
  "pg-types": [
    {
      copyright: ["Copyright (c) 2014 Brian M. Carlson"],
      like: "pg",
      from: "https://github.com/brianc/node-pg-types/blob/d9d9dfb87eb50914043cbc178c301b7dd3b0c50d/README.md#license",
    },
  ],
  pgpass: [
    {
      copyright: ["Copyright (c) 2013-2016 Hannes Hörl"],
      like: "pg",
      from: "https://github.com/hoegaarden/pgpass/blob/4230ed5e417ba6044ea7eb80b7c33db9ec301398/README.md#license",
    },
  ],
};

/** The part of esbuild's metafile read here: each output's inputs, by path from the build's directory. */
export type Metafile = {
  outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>;
};

/** Every file esbuild put code of into an output, absolute; a file tree-shaken to nothing is not shipped. */
export function bundledFiles(metafile: Metafile, cwd: string): string[] {
  return Object.values(metafile.outputs).flatMap((output) =>
    Object.entries(output.inputs)
      .filter(([, input]) => input.bytesInOutput > 0)
      .map(([path]) => resolve(cwd, path)),
  );
}

/**
 * The packages of node_modules/@img, which the Dockerfile copies into the
 * image: sharp's addon for the platform and @img/colour. libvips' package is
 * left to notices/libvips.json.
 */
export function imgDirs(root: string): string[] {
  const img = join(root, "node_modules", "@img");
  if (!existsSync(img)) return [];
  return readdirSync(img, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("sharp-libvips-"))
    .map((entry) => join(img, entry.name));
}

const RULE = "=".repeat(80);

/** A library built into libvips' shared library or into sharp's addon, with the releases and patches its build is made from. */
type Library = {
  name: string;
  version: string;
  license: string;
  source: string[];
  licences: Licence[];
};

/**
 * libvips' part (notices/libvips.json, #416): the package of
 * node_modules/@img that holds it, the build that made it, the versions that
 * build names, the keys of the LGPL-3.0, GPL-3.0 and MPL-2.0 texts, every
 * library built in with the licence it is used under and where it was read,
 * and the texts. Gathered from sharp-libvips' release and each library's
 * own at the version it names, by hand on 22/10/2026 and since by
 * `pnpm --filter @kuutti/api notices:libvips` (notices/libvips.ts, #421); a
 * sharp that brings another libvips fails the build until it is gathered
 * again, as notices/README.md says.
 */
export type LibvipsPart = {
  package: string;
  version: string;
  build: string;
  versions: Record<string, string>;
  lgpl: string;
  gpl: string;
  mpl2: string;
  libraries: Library[];
  texts: Record<string, string>;
};

/** The libvips package node_modules/@img holds, whichever platform's: its name, version and the versions of what it was built from. */
export function installedLibvips(
  root: string,
): { name: string; version: string; versions: Record<string, string> } | null {
  const img = join(root, "node_modules", "@img");
  const name = existsSync(img)
    ? readdirSync(img).find((entry) => entry.startsWith("sharp-libvips-"))
    : undefined;
  if (!name) return null;
  const read = (file: string) => JSON.parse(readFileSync(join(img, name, file), "utf8"));
  return {
    name: `@img/${name}`,
    version: read("package.json").version,
    versions: read("versions.json"),
  };
}

/** Refuses a libvips part that is not of the libvips installed: another version, or other libraries' versions. */
export function checkLibvips(part: LibvipsPart, root: string): void {
  const installed = installedLibvips(root);
  const same =
    installed?.version === part.version &&
    JSON.stringify(Object.entries(installed.versions).sort()) ===
      JSON.stringify(Object.entries(part.versions).sort());
  if (!same) {
    throw new Error(
      `notices/libvips.json is of ${part.package} ${part.version}, the install holds ${installed ? `${installed.name} ${installed.version}` : "no libvips"}: gather its libraries' texts again (pnpm --filter @kuutti/api notices:libvips, apps/api/notices/README.md)`,
    );
  }
}

const HEADER = `THIRD-PARTY NOTICES OF THE KUUTTI API IMAGE

This image runs the Kuutti API, free software under the GNU Affero General
Public License 3.0 with an additional permission (/app/LICENSE and
/app/LICENSE-EXCEPTION); the address of its source code is in the API's
/health. Its dist/ bundles the code of the packages below, and its
node_modules/@img holds sharp's prebuilt addon and libvips. Each package
follows with its copyright lines and the number of its licence's text, then
libvips and the libraries built into it, then the texts, each once, as their
files have them.`;

/** What LGPL-3.0 4(a) and GPL-3.0 6(d) ask to be said beside the object code of libvips. */
function libvipsIntro(part: LibvipsPart, number: (key: string) => number): string {
  return `${RULE}
LIBVIPS AND THE LIBRARIES BUILT INTO IT

node_modules/${part.package} ${part.version} holds libvips ${part.versions.vips} and the
libraries below, built by sharp-libvips into one shared library, which
sharp's addon (node_modules/${part.package.replace("sharp-libvips-", "sharp-")}) loads as the API
starts. libvips and the other libraries under the GNU Lesser General Public
License are used here under its version 3, as each of them allows: that
licence is text ${number(part.lgpl)} below, and the GNU General Public License 3.0, whose
terms it adds its permissions to, is text ${number(part.gpl)}. The shared library can be
replaced with another build of the same libraries.

The Corresponding Source of this build is sharp-libvips' build at
${part.build},
which fetches the release of each library named below with it and the
patches named with it, and builds them for this platform; each Rust crate
built into librsvg is the .crate file named with it. cairo is used under the
Mozilla Public License 1.1, and the crates under the Mozilla Public License
2.0 (text ${number(part.mpl2)}) under that licence; their source is at the same places.`;
}

/**
 * The notices file: what it is, each package with its copyright lines and
 * the number of each text, libvips' part with each library built into it,
 * and the texts once each in the order first named, a blank line between
 * any two.
 */
export function render(notices: Notices, part: LibvipsPart): string {
  const order = new Map<string, number>();
  const number = (key: string) => {
    const known = order.get(key);
    if (known !== undefined) return known;
    order.set(key, order.size + 1);
    return order.size;
  };
  const packages = notices.packages.map((p) => {
    const lines = [RULE, `${p.name} ${p.version} (${p.license})`];
    for (const licence of p.licences) {
      const from = licence.from
        ? `the package ships no licence file; from ${licence.from}`
        : `the package's ${licence.file}`;
      lines.push("", ...licence.copyright, `Licence: text ${number(licence.text)} below (${from})`);
    }
    for (const key of p.notices) {
      lines.push("", `Notice: text ${number(key)} below (the package's NOTICE)`);
    }
    return lines.join("\n");
  });
  const intro = libvipsIntro(part, number);
  const libraries = part.libraries.map((library) => {
    const lines = [
      RULE,
      `${library.name} ${library.version} (${library.license})`,
      ...library.source.map((url) => `Source: ${url}`),
    ];
    for (const licence of library.licences) {
      lines.push(
        "",
        ...licence.copyright,
        `Licence: text ${number(licence.text)} below (from ${licence.from})`,
      );
    }
    return lines.join("\n");
  });
  const all: Record<string, string> = { ...part.texts, ...notices.texts };
  const texts = [...order].map(([key, n]) => `${RULE}\nText ${n}\n\n${all[key]}`);
  return `${[HEADER, ...packages, intro, ...libraries, ...texts].join("\n\n")}\n`;
}

/** The files it reads and writes; the defaults are the build's. */
export type NoticePaths = {
  metafile: string;
  output: string;
  libvips: string;
  /** The directory tsup ran in, which the metafile's paths are from. */
  api: string;
  /** The workspace root, whose node_modules/@img the image carries. */
  root: string;
};

/** Writes the notices of the build, removes its metafile, and says how many packages, libraries and texts it holds. */
export function writeNotices(
  paths: NoticePaths = {
    metafile: METAFILE,
    output: OUTPUT,
    libvips: LIBVIPS,
    api: API,
    root: ROOT,
  },
  upstream: Readonly<Record<string, readonly Upstream[]>> = UPSTREAM,
): { packages: number; libraries: number } {
  const metafile: Metafile = JSON.parse(readFileSync(paths.metafile, "utf8"));
  const part: LibvipsPart = JSON.parse(readFileSync(paths.libvips, "utf8"));
  checkLibvips(part, paths.root);
  const dirs = [
    ...shippedPackageDirs(bundledFiles(metafile, paths.api), paths.root),
    ...imgDirs(paths.root),
  ];
  const notices = collectNotices(dirs, upstream);
  writeFileSync(paths.output, render(notices, part));
  rmSync(paths.metafile);
  return { packages: notices.packages.length, libraries: part.libraries.length };
}
