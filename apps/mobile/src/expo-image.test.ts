import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// #547: on Android Glide decodes blurhashes on several threads, and expo-image's
// BlurhashDecoder, copied from woltapp/blurhash, shares its cosine tables between
// them in plain HashMaps. A table goes into the map empty and is filled while
// the bitmap that made it is composed, so a decode that starts meanwhile reads
// the rows not yet filled as zeros and paints them black, and Glide keeps that
// bitmap on disk under the blurhash. No release of expo-image carries a fix, so
// the patch (patches/expo-image@57.0.5.patch) makes the decoder take one bitmap
// at a time. The race cannot be made to happen on demand, so this holds the
// installed native source to the fix instead, and the build to using that
// source: a build otherwise takes the package's prebuilt library, in which the
// patch is not, and nothing else would say so.
const decoder = readFileSync(
  join(
    dirname(require.resolve("expo-image/package.json")),
    "android/src/main/java/expo/modules/image/blurhash/BlurhashDecoder.kt",
  ),
  "utf8",
);
const app = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));

describe("expo-image's blurhash decoder on Android (#547)", () => {
  it("is built from the patched source, never taken from the package's prebuilt library", () => {
    expect(app.expo.autolinking.android.buildFromSource).toContain("expo-image");
  });

  it("composes one bitmap at a time, so no decode reads a table another is filling", () => {
    expect(decoder).toMatch(/@Synchronized\s+private fun composeBitmap\(/);
  });

  it("clears the tables under the same lock, since low memory can clear them mid-decode", () => {
    expect(decoder).toMatch(/@Synchronized\s+fun clearCache\(/);
  });
});
