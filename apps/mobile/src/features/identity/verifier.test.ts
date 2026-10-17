import { createHash } from "node:crypto";
import { challengeOf, newVerifier } from "./verifier";

// What binds the bank login's one-time code to this phone (ADR-027): a fresh
// verifier for every attempt, and the SHA-256 that /auth/start carries, in
// the hex the API hashes it to.

const HEX_64 = /^[0-9a-f]{64}$/;

afterEach(() => jest.restoreAllMocks());

describe("the sign-in attempt's verifier", () => {
  it("is 64 lowercase hex characters from two native UUIDs", () => {
    const uuidv4 = jest.spyOn(globalThis.expo, "uuidv4");
    expect(newVerifier()).toMatch(HEX_64);
    expect(uuidv4).toHaveBeenCalledTimes(2);
  });

  it("joins the two UUIDs without their dashes, in lowercase", () => {
    jest
      .spyOn(globalThis.expo, "uuidv4")
      .mockReturnValueOnce("0A1B2C3D-4E5F-4A6B-8C7D-8E9F0A1B2C3D")
      .mockReturnValueOnce("f0e1d2c3-b4a5-4968-a776-655443322110");
    expect(newVerifier()).toBe("0a1b2c3d4e5f4a6b8c7d8e9f0a1b2c3df0e1d2c3b4a54968a776655443322110");
  });

  it("is a new one for every attempt", () => {
    const verifiers = Array.from({ length: 100 }, () => newVerifier());
    expect(new Set(verifiers).size).toBe(100);
  });
});

describe("its challenge", () => {
  it("is the SHA-256 of the verifier as lowercase hex, as the API hashes it", () => {
    const verifier = newVerifier();
    const challenge = challengeOf(verifier);
    expect(challenge).toMatch(HEX_64);
    expect(challenge).toBe(createHash("sha256").update(verifier, "utf8").digest("hex"));
    expect(challenge).not.toBe(verifier);
  });

  it("is the standard's SHA-256 (FIPS 180-2's test vector)", () => {
    expect(challengeOf("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("differs between two verifiers", () => {
    expect(challengeOf("5a1e".repeat(16))).not.toBe(challengeOf("5a1f".repeat(16)));
  });
});
