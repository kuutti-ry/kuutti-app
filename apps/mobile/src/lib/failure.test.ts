import { ProfileResponse } from "@kuutti/schema";
import { ApiError } from "./api";
import { failureKind } from "./failure";

// Why a load failed, in the terms a person acts on (LoadFailed): no answer, a
// failed API, an answer this build cannot read, or anything else.

describe("failureKind", () => {
  it("reads a server error from its status, and any other refusal as other", () => {
    expect(failureKind(new ApiError("profile answered 500", 500, "internal_error"))).toBe("server");
    expect(failureKind(new ApiError("profile answered 503", 503))).toBe("server");
    expect(failureKind(new ApiError("profile answered 404", 404, "not_found"))).toBe("other");
    expect(failureKind(new ApiError("health answered nothing"))).toBe("other");
  });

  it("reads an answer the contract refuses as an app older than its API", () => {
    const refused = ProfileResponse.safeParse({ profile: null, completeness: {}, tips: [] });
    expect(refused.success).toBe(false);
    expect(failureKind(refused.error)).toBe("outdated");
  });

  it("reads fetch's own network failures as offline, and no other TypeError", () => {
    expect(failureKind(new TypeError("Network request failed"))).toBe("offline");
    expect(failureKind(new TypeError("Failed to fetch"))).toBe("offline");
    expect(failureKind(new TypeError("Load failed"))).toBe("offline");
    // A bug in the app is not the network.
    expect(failureKind(new TypeError("undefined is not an object"))).toBe("other");
  });

  it("reads anything else as other", () => {
    expect(failureKind(new Error("boom"))).toBe("other");
    expect(failureKind("a string")).toBe("other");
    expect(failureKind(null)).toBe("other");
    expect(failureKind(undefined)).toBe("other");
  });
});
