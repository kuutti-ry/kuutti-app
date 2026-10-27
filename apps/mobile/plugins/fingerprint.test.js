/**
 * @jest-environment node
 */
const { execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const saiga = require("../../../scripts/saiga.json");

// One fingerprint with Saiga and without (ADR-052): EAS builds with it, the
// GitHub runners that compute the runtime version of an update never have it
// (deploy.yml, preview.yml, eas-build.yml, e2e.yml). If the two differed,
// updates would stop reaching the builds. Each machine is a process of its
// own with its own HOME, as a runner is: Jest's process.env is a copy that
// neither os.homedir() nor a child process reads. Stand-in files: the plugin
// reads names, never bytes.
const project = join(__dirname, "..");
const MACHINE = `
const { createFingerprintAsync } = require(${JSON.stringify(require.resolve("@expo/fingerprint"))});
const withSaiga = require(${JSON.stringify(join(__dirname, "withSaiga.js"))});
// expo-font's plugin runs once per config and leaves its name in the history.
const embeds = Boolean(withSaiga({})._internal?.pluginHistory?.["expo-font"]);
createFingerprintAsync(${JSON.stringify(project)}, { platforms: ["android", "ios"] }).then(({ hash }) =>
  process.stdout.write(JSON.stringify({ hash, embeds })),
);`;

function machine(home) {
  const out = execFileSync(process.execPath, ["-e", MACHINE], {
    cwd: project,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kuutti-saiga-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("is one fingerprint whether the machine has Saiga or not", () => {
  const without = machine(join(dir, "without"));
  const ttf = join(dir, "with", ".cache", "kuutti-fonts", `saiga-${saiga.version}`, "TTF");
  mkdirSync(ttf, { recursive: true });
  for (const { name } of saiga.faces) writeFileSync(join(ttf, `${name}.ttf`), "a stand-in");
  const withIt = machine(join(dir, "with"));
  expect([without.embeds, withIt.embeds]).toEqual([false, true]);
  expect(withIt.hash).toBe(without.hash);
}, 120_000);

// eas.json's contents are no part of the fingerprint (fingerprint.config.js,
// ADR-057): a new profile or submission must not orphan installed builds. An
// ignored file may stay listed, with no hash.
it("leaves eas.json's contents out of the fingerprint", async () => {
  const { createFingerprintAsync } = require("@expo/fingerprint");
  const { sources } = await createFingerprintAsync(project, { platforms: ["android", "ios"] });
  const hashed = sources.filter((source) => source.filePath === "eas.json" && source.hash !== null);
  expect(hashed).toEqual([]);
}, 120_000);

// What would make eas.json native again: an env a config plugin reads, a
// prebuild of its own, or a custom build's steps. One of them needs eas.json
// back in the fingerprint first.
it("gives no build profile an env, a prebuild command or a custom build config", () => {
  const { build } = require("../eas.json");
  const native = Object.entries(build).flatMap(([name, profile]) =>
    [
      [name, profile],
      [`${name}.android`, profile.android],
      [`${name}.ios`, profile.ios],
    ]
      .filter(([, part]) => part !== undefined)
      .flatMap(([where, part]) =>
        ["env", "prebuildCommand", "config"]
          .filter((key) => key in part)
          .map((key) => `${where}.${key}`),
      ),
  );
  expect(native).toEqual([]);
});
