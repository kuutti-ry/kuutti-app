/**
 * @jest-environment node
 */
const { join } = require("node:path");
const { getConfig } = require("expo/config");
const { AndroidConfig, compileModsAsync } = require("expo/config-plugins");

// The app's own config, through every plugin app.json names, as a prebuild
// would write the Android theme (`expo config --type introspect`). Jest has no
// Android text layout to wrap a label in, so the test holds the declaration
// that keeps TextView laying out by advances, as React Native measures (#518).
const project = join(__dirname, "..");

it("lays the Android theme's text out by advances, as React Native measures it", async () => {
  const { exp } = getConfig(project, { skipSDKVersionRequirement: true, isModdedConfig: true });
  const config = await compileModsAsync(exp, {
    projectRoot: project,
    introspect: true,
    platforms: ["android"],
    assertMissingModProviders: false,
  });
  const item = AndroidConfig.Styles.getStylesItem({
    xml: config._internal.modResults.android.styles,
    parent: AndroidConfig.Styles.getAppThemeGroup(),
    name: "android:useBoundsForWidth",
  });
  expect(item?._).toBe("false");
}, 60_000);
