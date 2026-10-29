import { cn } from "./utils";

describe("cn", () => {
  it("lets a later utility win over an earlier one", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-sm", false, "font-semibold")).toBe("text-sm font-semibold");
  });

  it("knows the theme's touch size, so a caller's height replaces it (#511)", () => {
    expect(cn("min-h-touch", "min-h-32")).toBe("min-h-32");
    expect(cn("min-w-touch", "min-w-40")).toBe("min-w-40");
    expect(cn("min-h-touch w-full", "grow")).toBe("min-h-touch w-full grow");
  });
});
