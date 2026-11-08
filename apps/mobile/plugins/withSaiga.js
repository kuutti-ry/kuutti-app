const { existsSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const withFonts = require("expo-font/app.plugin").default;
const saiga = require("../../../scripts/saiga.json");

/**
 * Saiga, Kuutti's typeface, embedded in the native build when this machine
 * has it, and nothing otherwise (ADR-052). Its files are never in the
 * repository: `pnpm fonts` (scripts/fonts.ts) puts them in
 * ~/.cache/kuutti-fonts on a member's laptop, and on the EAS builder before
 * the install. A build without them is in the system font: React Native falls
 * back to it for a family it does not know, on both platforms, so the
 * JavaScript is the same either way.
 *
 * app.json names this plugin without options, so expo-font's font list, which
 * @expo/fingerprint hashes, is never in the config, and the same modules load
 * either way: a build with Saiga and one without have one fingerprint, and an
 * update reaches both. A new release of Saiga changes scripts/saiga.json,
 * which moves it, as an embedded font's change must. The test holds this.
 *
 * iOS registers the files (UIAppFonts) and finds the weights in the family
 * "Saiga" by itself; Android needs them declared as one family with their
 * weights, or `fontWeight` would draw a synthetic bold.
 */
module.exports = function withSaiga(config) {
  const dir = join(homedir(), ".cache", "kuutti-fonts", `saiga-${saiga.version}`, "TTF");
  const faces = saiga.faces.map((face) => ({ ...face, path: join(dir, `${face.name}.ttf`) }));
  // All or none, as `pnpm fonts` writes them: half a family would mix faces.
  if (!faces.every(({ path }) => existsSync(path))) return config;
  return withFonts(config, {
    ios: { fonts: faces.map(({ path }) => path) },
    android: {
      fonts: [
        {
          fontFamily: "Saiga",
          fontDefinitions: faces.map(({ path, weight, style }) => ({ path, weight, style })),
        },
      ],
    },
  });
};
