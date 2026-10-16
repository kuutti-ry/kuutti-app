// @vitest-environment node
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

// The CloudFront Function of the panel's previews (#313, ADR-025 §6), run here
// in a context of its own as CloudFront runs it: no Node, no module system,
// only `handler`. A path inside /pr-<n>/ whose last segment has no dot is a
// page of that preview and gets its index.html; everything else passes
// through to the bucket untouched, where the root has the distribution's own
// fallback (§2).

type Request = { method: string; uri: string; querystring: Record<string, { value: string }> };
type Handler = (event: { request: Request }) => Request;

const source = readFileSync(
  new URL("../../../infra/modules/admin/previews.js", import.meta.url),
  "utf8",
);
const context = createContext({});
runInContext(source, context);
const handler = context.handler as Handler;

const uuid = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";

/** The uri CloudFront would ask the bucket for, given the viewer's. */
function served(uri: string): string {
  return handler({ request: { method: "GET", uri, querystring: {} } }).uri;
}

describe("the previews' CloudFront Function", () => {
  it.each([
    ["the preview's own address without its last slash", "/pr-12", "/pr-12/index.html"],
    ["the preview's own address with it", "/pr-12/", "/pr-12/index.html"],
    ["a page", "/pr-12/photos", "/pr-12/index.html"],
    ["a page with a trailing slash", "/pr-12/photos/", "/pr-12/index.html"],
    ["a nested page with an account id", `/pr-12/accounts/${uuid}`, "/pr-12/index.html"],
    ["a page under a segment with a dot", "/pr-12/v1.2/photos", "/pr-12/index.html"],
    ["the first preview there could be", "/pr-1/feedback", "/pr-1/index.html"],
  ])("answers %s with that preview's index.html", (_, uri, expected) => {
    expect(served(uri)).toBe(expected);
  });

  it.each([
    ["an asset of a preview", "/pr-12/assets/index-Bx3k9.js"],
    ["a source map of a preview", "/pr-12/assets/index-Bx3k9.js.map"],
    ["a preview's index.html itself", "/pr-12/index.html"],
    ["a nested path ending in a file", "/pr-12/accounts/x.png"],
    ["the root", "/"],
    ["a page of the root", "/photos"],
    ["a nested page of the root", `/accounts/${uuid}`],
    ["the root's index.html", "/index.html"],
    ["an asset of the root", "/assets/index-Bx3k9.js"],
    ["a prefix without a number", "/pr-x"],
    ["a page under a prefix without a number", "/pr-x/photos"],
    ["a prefix with nothing after the dash", "/pr-"],
    ["a number with more after it", "/pr-12x"],
    ["a page under a number with more after it", "/pr-12x/photos"],
    ["a preview's name further down a path", "/photos/pr-12/feedback"],
  ])("passes %s through untouched", (_, uri) => {
    expect(served(uri)).toBe(uri);
  });

  it("keeps the query string out of the uri and leaves it as it came", () => {
    const querystring = { cursor: { value: "abc" }, page: { value: "2" } };
    const request = handler({
      request: { method: "GET", uri: "/pr-12/audit", querystring },
    });
    expect(request.uri).toBe("/pr-12/index.html");
    expect(request.querystring).toEqual({ cursor: { value: "abc" }, page: { value: "2" } });
  });

  it("answers with the request it was given, the rest of it unchanged", () => {
    const request: Request = { method: "HEAD", uri: "/pr-3/staff", querystring: {} };
    expect(handler({ request })).toBe(request);
    expect(request).toEqual({ method: "HEAD", uri: "/pr-3/index.html", querystring: {} });
  });
});
