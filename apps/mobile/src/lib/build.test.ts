import { buildInfo } from "./build";

// The version and the commit a build names (#172, #287).

describe("buildInfo", () => {
  it("takes the counted version and the commit from extra, before app.json's version", () => {
    expect(
      buildInfo({ version: "1.2.3", extra: { version: "0.19.0", commit: "abc1234" } }),
    ).toEqual({ version: "0.19.0", commit: "abc1234" });
  });

  it("falls back to app.json's version when extra has none", () => {
    expect(buildInfo({ version: "1.2.3", extra: {} })).toEqual({ version: "1.2.3", commit: null });
  });

  it("names nothing for an empty or a wrong-typed value, or no config at all", () => {
    expect(buildInfo({ extra: { version: "", commit: "" } })).toEqual({
      version: null,
      commit: null,
    });
    expect(buildInfo({ extra: { version: 19, commit: ["abc"] } })).toEqual({
      version: null,
      commit: null,
    });
    expect(buildInfo(null)).toEqual({ version: null, commit: null });
    expect(buildInfo(undefined)).toEqual({ version: null, commit: null });
  });
});
