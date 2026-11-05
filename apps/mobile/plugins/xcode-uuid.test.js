/**
 * @jest-environment node
 */
const xcode = require("xcode");

// pnpm-workspace.yaml overrides the uuid 7 under xcode across a major, to 11.1.1
// (GHSA-w5hq-g745-h8pq, #586). Expo's config plugins edit the iOS project with
// xcode at prebuild, which names everything a plugin adds with uuid.v4, and
// nothing else in CI runs that before a native build does. Goes with the override.
it("xcode names a new project object through the uuid the override gives it", () => {
  const project = xcode.project("project.pbxproj");
  project.hash = { project: { objects: {} } };

  expect(project.generateUuid()).toMatch(/^[0-9A-F]{24}$/);
});
