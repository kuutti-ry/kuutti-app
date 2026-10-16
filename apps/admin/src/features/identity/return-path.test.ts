import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberReturnPath, restoreReturnPath } from "./return-path.ts";

// The way back from the bank (#302): the path the sign-in started on, put
// back before the router starts, once, and only a path of this origin.

const KEY = "kuutti.admin.return";
const CODE = `#code=${"c".repeat(43)}`;

function history() {
  return { replaceState: vi.fn() };
}

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("rememberReturnPath", () => {
  it("keeps the path and the query the person is on", () => {
    rememberReturnPath({ pathname: "/feedback", search: "?kind=bug" });
    expect(window.sessionStorage.getItem(KEY)).toBe("/feedback?kind=bug");
  });

  it("does not throw when the browser keeps no storage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(() => rememberReturnPath({ pathname: "/feedback", search: "" })).not.toThrow();
  });
});

describe("restoreReturnPath", () => {
  it("puts the remembered path back with the code still in the fragment, and forgets it", () => {
    window.sessionStorage.setItem(KEY, "/feedback?kind=bug");
    const h = history();
    restoreReturnPath({ hash: CODE }, h);
    expect(h.replaceState).toHaveBeenCalledWith(null, "", `/feedback?kind=bug${CODE}`);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("does the same for a refusal, so it is shown where the person was", () => {
    window.sessionStorage.setItem(KEY, "/photos");
    const h = history();
    restoreReturnPath({ hash: "#error=admin_not_allowed" }, h);
    expect(h.replaceState).toHaveBeenCalledWith(null, "", "/photos#error=admin_not_allowed");
  });

  it("does nothing on an ordinary load, and keeps what was remembered", () => {
    window.sessionStorage.setItem(KEY, "/feedback");
    const h = history();
    restoreReturnPath({ hash: "" }, h);
    restoreReturnPath({ hash: "#main" }, h);
    expect(h.replaceState).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(KEY)).toBe("/feedback");
  });

  it("leaves the address alone when nothing was remembered", () => {
    const h = history();
    restoreReturnPath({ hash: CODE }, h);
    expect(h.replaceState).not.toHaveBeenCalled();
  });

  it.each([
    ["another host", "//evil.example/photos"],
    ["another host behind a backslash", "/\\evil.example/photos"],
    ["a full address", "https://evil.example/photos"],
    ["a script", "javascript:alert(1)"],
    ["a relative path", "photos"],
    ["nothing", ""],
  ])("drops %s and forgets it", (_what, stored) => {
    window.sessionStorage.setItem(KEY, stored);
    const h = history();
    restoreReturnPath({ hash: CODE }, h);
    expect(h.replaceState).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("does not throw, and moves nothing, when the browser keeps no storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const h = history();
    expect(() => restoreReturnPath({ hash: CODE }, h)).not.toThrow();
    expect(h.replaceState).not.toHaveBeenCalled();
  });

  it("reads the page's own address and history when given none", () => {
    window.sessionStorage.setItem(KEY, "/feedback");
    window.history.replaceState(null, "", `/${CODE}`);
    restoreReturnPath();
    expect(window.location.pathname).toBe("/feedback");
    expect(window.location.hash).toBe(CODE);
    window.history.replaceState(null, "", "/");
  });
});
