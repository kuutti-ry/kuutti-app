const { AndroidConfig, withAndroidStyles } = require("expo/config-plugins");

/**
 * From Android 15, a TextView of an app that targets API 35 or later breaks
 * its lines by the ink of its glyphs (TextView's USE_BOUNDS_FOR_WIDTH), while
 * React Native 0.86 still measures text by their advances (TextLayoutManager's
 * StaticLayout). A text sized to its own width, as a button's label is, was
 * measured one line wide by its advances and then wrapped by its ink, which
 * reaches a little past the advances where an edge glyph overhangs; the second
 * line fell outside the one-line box: "Set a passcode" drew "Set a" (#518). On
 * the theme, every TextView and EditText lays out by advances again, as React
 * Native measures them, as Android 14 does and as iOS does.
 *
 * What would let it go: React Native measuring by the ink too. Its attempt
 * (8347cc4, a two-pass layout) was reverted and is not in 0.86.
 */
module.exports = function withAdvanceWidths(config) {
  return withAndroidStyles(config, (mod) => {
    mod.modResults = AndroidConfig.Styles.assignStylesValue(mod.modResults, {
      add: true,
      parent: AndroidConfig.Styles.getAppThemeGroup(),
      name: "android:useBoundsForWidth",
      value: "false",
    });
    return mod;
  });
};
