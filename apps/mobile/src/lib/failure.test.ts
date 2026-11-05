import { ProfileResponse } from "@kuutti/schema";
// Expo's own class, so that an SDK that changes what a phone's fetch throws turns this red.
import { FetchError } from "expo/src/winter/fetch/FetchErrors";
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

  it("reads a phone's failed fetch as offline, whatever words the platform gives", () => {
    expect(failureKind(new FetchError("Could not connect to the server."))).toBe("offline");
    expect(failureKind(new FetchError("The Internet connection appears to be offline."))).toBe(
      "offline",
    );
    expect(failureKind(new FetchError("Yhteyden muodostaminen palvelimeen ei onnistunut."))).toBe(
      "offline",
    );
    expect(failureKind(new FetchError("Failed to connect to /127.0.0.1:3000"))).toBe("offline");
    expect(failureKind(new FetchError('Unable to resolve host "api.kuutti.app"'))).toBe("offline");
    expect(failureKind(FetchError.createFromError(new Error("timeout")))).toBe("offline");
  });

  it("reads a request left behind as other, since the network did not fail", () => {
    expect(failureKind(new FetchError("The operation was aborted."))).toBe("other");
    expect(failureKind(new FetchError("Fetch request has been canceled"))).toBe("other");
  });

  it("reads anything else as other", () => {
    expect(failureKind(new Error("boom"))).toBe("other");
    expect(failureKind("a string")).toBe("other");
    expect(failureKind(null)).toBe("other");
    expect(failureKind(undefined)).toBe("other");
  });
});
