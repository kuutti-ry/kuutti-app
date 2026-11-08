import { cn } from "./utils";

describe("cn", () => {
  it("lets a later utility win over an earlier one", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-sm", false, "font-semibold")).toBe("text-sm font-semibold");
  });

  it("knows the type scale's sizes, so a colour beside one keeps it and a later one replaces it (#408)", () => {
    expect(cn("text-body text-foreground")).toBe("text-body text-foreground");
    expect(cn("text-body text-foreground", "text-control")).toBe("text-foreground text-control");
    expect(cn("text-h1", "text-h1/[normal]")).toBe("text-h1/[normal]");
    expect(cn("font-system", "font-sans")).toBe("font-sans");
  });

  it("knows the theme's touch size, so a caller's height replaces it (#511)", () => {
    expect(cn("min-h-touch", "min-h-32")).toBe("min-h-32");
    expect(cn("min-w-touch", "min-w-40")).toBe("min-w-40");
    expect(cn("min-h-touch w-full", "grow")).toBe("min-h-touch w-full grow");
  });
});
