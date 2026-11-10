import { describe, expect, it } from "vitest";
import { short } from "./utils.ts";

describe("short", () => {
  it("keeps an id's first eight characters, as the panel shows an id (#171)", () => {
    expect(short("3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a70")).toBe("3f9a2c1e");
  });

  it("keeps an id shorter than that whole", () => {
    expect(short("3f9a")).toBe("3f9a");
  });
});
