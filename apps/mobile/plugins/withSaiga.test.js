/**
 * @jest-environment node
 */
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const saiga = require("../../../scripts/saiga.json");

// The plugin embeds Saiga when this machine has every face and nothing
// otherwise (ADR-052). Stand-in files: the plugin reads names, never bytes,
// and Saiga's own never come near a test.
jest.mock("expo-font/app.plugin", () => ({
  default: jest.fn((config) => ({ ...config, withFonts: true })),
}));
// Jest's process.env is its own copy, which os.homedir() never reads.
let mockHome;
jest.mock("node:os", () => ({ ...jest.requireActual("node:os"), homedir: () => mockHome }));
const withFonts = require("expo-font/app.plugin").default;
const withSaiga = require("./withSaiga");

const config = { name: "Kuutti", slug: "kuutti" };
let dir;

function faces(names) {
  const ttf = join(dir, ".cache", "kuutti-fonts", `saiga-${saiga.version}`, "TTF");
  mkdirSync(ttf, { recursive: true });
  for (const name of names) writeFileSync(join(ttf, `${name}.ttf`), "a stand-in");
  return ttf;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kuutti-saiga-"));
  mockHome = dir;
  withFonts.mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Saiga in the native build (ADR-052)", () => {
  it("leaves the config as it is on a machine without Saiga: the build is in the system font", () => {
    expect(withSaiga(config)).toBe(config);
    expect(withFonts).not.toHaveBeenCalled();
  });

  it("embeds none of it when a face is missing, rather than half a family", () => {
    faces(saiga.faces.slice(1).map(({ name }) => name));
    expect(withSaiga(config)).toBe(config);
    expect(withFonts).not.toHaveBeenCalled();
  });

  it("embeds every face, for iOS by file and for Android as the one family Saiga with its weights", () => {
    const ttf = faces(saiga.faces.map(({ name }) => name));
    expect(withSaiga(config)).toEqual({ ...config, withFonts: true });
    const paths = saiga.faces.map(({ name }) => join(ttf, `${name}.ttf`));
    expect(withFonts).toHaveBeenCalledWith(config, {
      ios: { fonts: paths },
      android: {
        fonts: [
          {
            fontFamily: "Saiga",
            fontDefinitions: [
              { path: paths[0], weight: 400, style: "normal" },
              { path: paths[1], weight: 400, style: "italic" },
              { path: paths[2], weight: 500, style: "normal" },
              { path: paths[3], weight: 700, style: "normal" },
              { path: paths[4], weight: 800, style: "normal" },
            ],
          },
        ],
      },
    });
  });
});
