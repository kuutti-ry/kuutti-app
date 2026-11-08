import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { originProofOf } from "./origin-proof.ts";

const SEEDED = { seed: 20261106 };
const SECRET = "origin-proof-of-the-test-4711-4711-4711";
const NEXT = "the-next-origin-proof-4711-4711-4711";

describe("the proof of Kuutti's distribution (ADR-066)", () => {
  it("is unset when the process has no secret to check it against, whatever the request sends", () => {
    const proof = originProofOf([]);
    expect(proof(undefined)).toBe("unset");
    expect(proof(SECRET)).toBe("unset");
  });

  it("is missing when the request carries no header, or an empty one", () => {
    const proof = originProofOf([SECRET]);
    expect(proof(undefined)).toBe("missing");
    expect(proof("")).toBe("missing");
  });

  it("is valid for the secret itself, and wrong for one character more, less or different", () => {
    const proof = originProofOf([SECRET]);
    expect(proof(SECRET)).toBe("valid");
    expect(proof(`${SECRET}x`)).toBe("wrong");
    expect(proof(SECRET.slice(0, -1))).toBe("wrong");
    expect(proof(`${SECRET.slice(0, -1)}2`)).toBe("wrong");
    expect(proof(SECRET.toUpperCase())).toBe("wrong");
    expect(proof(` ${SECRET}`)).toBe("wrong");
  });

  it("takes either secret while one replaces the other, and nothing else", () => {
    const proof = originProofOf([SECRET, NEXT]);
    expect(proof(SECRET)).toBe("valid");
    expect(proof(NEXT)).toBe("valid");
    expect(proof(`${SECRET}${NEXT}`)).toBe("wrong");
  });

  it("finds any string but a secret wrong, whatever its length or characters", () => {
    const proof = originProofOf([SECRET, NEXT]);
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200, unit: "grapheme" }), (header) => {
        fc.pre(header !== SECRET && header !== NEXT);
        return proof(header) === "wrong";
      }),
      SEEDED,
    );
  });
});
