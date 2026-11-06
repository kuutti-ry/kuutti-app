import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSignInStart } from "./routes.ts";

// The edge's rate rule leaves the two sign-in starts to the API (ADR-067 §2):
// the API refuses a start with a redirect back to the app or the panel
// (ADR-026 §4), where the edge's 429 would leave a JSON page in the system
// browser. infra/modules/media/edge.tf reads their raw paths from edge.json and
// counts every other path, so a renamed start must be renamed there too.
const { uncounted } = JSON.parse(
  readFileSync(new URL("../../../../infra/modules/media/edge.json", import.meta.url), "utf8"),
) as { uncounted: string[] };

describe("the edge's uncounted paths", () => {
  it("are the two sign-in starts, each once, and nothing else", () => {
    expect(uncounted).toHaveLength(2);
    expect(new Set(uncounted.filter(isSignInStart)).size).toBe(2);
  });
});
