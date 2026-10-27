const { SourceSkips } = require("@expo/fingerprint");

// The `extra` section carries the git commit of the JavaScript (app.config.ts).
// It is not native: a new commit must not read as a new runtime version, or
// every push would spend a build and orphan every installed one (rules/mobile.md).
// eas.json is left out for the same reason: it says how EAS builds, signs and
// submits (ADR-057), not what a build compiles. Only a profile's env,
// prebuildCommand or custom build config could change that, and
// plugins/fingerprint.test.js refuses all three while eas.json is ignored here.
module.exports = { sourceSkips: SourceSkips.ExpoConfigExtraSection, ignorePaths: ["eas.json"] };
