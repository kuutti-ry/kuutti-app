import { appEnvironmentOf } from "./environment";

describe("the app's environment", () => {
  it("is read from the update channel", () => {
    expect(appEnvironmentOf(null)).toBe("development");
    expect(appEnvironmentOf(undefined)).toBe("development");
    expect(appEnvironmentOf("")).toBe("development");
    expect(appEnvironmentOf("production")).toBe("production");
    expect(appEnvironmentOf("pr-42")).toBe("preview");
    expect(appEnvironmentOf("staging")).toBe("staging");
    expect(appEnvironmentOf("anything-else")).toBe("staging");
  });

  it("takes the override for a build, except over the production channel", () => {
    expect(appEnvironmentOf(null, "staging")).toBe("staging");
    expect(appEnvironmentOf("staging", "preview")).toBe("preview");
    expect(appEnvironmentOf("production", "development")).toBe("production");
  });

  it("ignores an override that names no environment", () => {
    expect(appEnvironmentOf(null, "prod")).toBe("development");
    expect(appEnvironmentOf("staging", "")).toBe("staging");
  });
});
