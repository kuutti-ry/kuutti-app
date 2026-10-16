import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectLicenses,
  installedPackages,
  type LicenseEntry,
  OUTPUT,
  shippedPackageDirs,
} from "./licenses";

describe("the packages a bundle's source maps name (#177)", () => {
  it("is the directory after the last node_modules, from the workspace root, each once", () => {
    expect(
      shippedPackageDirs(
        [
          "/node_modules/react/index.js",
          "/node_modules/react/cjs/react.production.js",
          "/node_modules/@react-native/js-polyfills/console.js",
          "/apps/mobile/node_modules/expo/src/Expo.ts",
          "/node_modules/react-native/node_modules/scheduler/index.js",
          "/repo/node_modules/@formatjs/intl-locale/index.js",
        ],
        "/repo",
      ),
    ).toEqual([
      "/repo/apps/mobile/node_modules/expo",
      "/repo/node_modules/@formatjs/intl-locale",
      "/repo/node_modules/@react-native/js-polyfills",
      "/repo/node_modules/react",
      "/repo/node_modules/react-native/node_modules/scheduler",
    ]);
  });

  it("leaves out Metro's virtual modules, a require.context query, our own files and a path with no file in a package", () => {
    expect(
      shippedPackageDirs(
        [
          "__prelude__",
          "__debugid__",
          "\0polyfill:external-require",
          "/apps/mobile/app?ctx=3ab07f305c4346b25020dd398f4d6d4dc9229acb",
          "/apps/mobile/src/features/profile/index.ts",
          "/packages/schema/src/index.ts",
          "/node_modules/@scope",
          "/node_modules/react",
          "",
        ],
        "/repo",
      ),
    ).toEqual([]);
  });

  it("reads a query off a file too", () => {
    expect(shippedPackageDirs(["/node_modules/a/index.js?ctx=1"], "/repo")).toEqual([
      "/repo/node_modules/a",
    ]);
  });
});

describe("the licence of a package (#143)", () => {
  let root = "";
  const pkg = (dir: string, manifest: Record<string, unknown>): string => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(manifest));
    return join(root, dir);
  };
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "kuutti-licenses-test-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads a string, an object with a type, a list of either, and says unknown when there is none", () => {
    const dirs = [
      pkg("node_modules/plain", { name: "plain", version: "1.0.0", license: "MIT" }),
      pkg("node_modules/typed", {
        name: "typed",
        version: "2.0.0",
        license: { type: "ISC", url: "https://example.invalid/isc" },
      }),
      pkg("node_modules/listed", {
        name: "listed",
        version: "3.0.0",
        licenses: [{ type: "MIT" }, "Apache-2.0"],
      }),
      pkg("node_modules/silent", { name: "silent", version: "4.0.0" }),
    ];
    expect(collectLicenses(dirs)).toEqual([
      { name: "listed", version: "3.0.0", license: "MIT OR Apache-2.0" },
      { name: "plain", version: "1.0.0", license: "MIT" },
      { name: "silent", version: "4.0.0", license: "unknown" },
      { name: "typed", version: "2.0.0", license: "ISC" },
    ]);
  });

  it("names a package once however many copies are bundled, a second version on a line of its own", () => {
    const dirs = [
      pkg("node_modules/a/node_modules/dup", { name: "dup", version: "1.0.0", license: "MIT" }),
      pkg("node_modules/b/node_modules/dup", { name: "dup", version: "1.0.0", license: "MIT" }),
      pkg("node_modules/dup", { name: "dup", version: "1.1.0", license: "MIT" }),
      pkg("node_modules/nameless", { version: "0.0.1", license: "0BSD" }),
    ];
    expect(collectLicenses(dirs)).toEqual([
      { name: "dup", version: "1.0.0", license: "MIT" },
      { name: "dup", version: "1.1.0", license: "MIT" },
      { name: "nameless", version: "0.0.1", license: "0BSD" },
    ]);
  });
});

describe("the packages installed for the app", () => {
  const names = new Set(installedPackages().map((e) => e.name));

  it("follows our workspace packages' dependencies without listing the packages themselves", () => {
    expect(names.has("zod")).toBe(true);
    expect([...names].filter((n) => n.startsWith("@kuutti/"))).toEqual([]);
  });

  it("leaves out optional dependencies, the installing machine's and not the app's", () => {
    expect([...names].filter((n) => n === "fsevents" || n.startsWith("@sentry/cli-"))).toEqual([]);
  });
});

describe("src/generated/licenses.json (#143, #177)", () => {
  const committed: LicenseEntry[] = JSON.parse(readFileSync(OUTPUT, "utf8"));

  it("names the packages the app is made of, each with a licence, none of them ours", () => {
    const names = new Set(committed.map((e) => e.name));
    const missing = ["expo", "react-native", "react", "expo-router", "zod", "i18next"].filter(
      (n) => !names.has(n),
    );
    expect(missing).toEqual([]);
    expect(committed.filter((e) => !e.license || e.license === "unknown")).toEqual([]);
    expect(committed.filter((e) => e.name.startsWith("@kuutti/"))).toEqual([]);
  });

  it("leaves out what never reaches a phone: the web target, a config plugin, the build tooling", () => {
    const names = new Set(committed.map((e) => e.name));
    expect(
      ["react-native-web", "react-dom", "expo-build-properties", "@babel/core"].filter((n) =>
        names.has(n),
      ),
    ).toEqual([]);
  });

  it("is a part of what is installed, at the installed versions; stale? pnpm --filter mobile run licenses", () => {
    const installed = new Set(
      installedPackages().map((e) => `${e.name}@${e.version} ${e.license}`),
    );
    expect(committed.filter((e) => !installed.has(`${e.name}@${e.version} ${e.license}`))).toEqual(
      [],
    );
  });
});
