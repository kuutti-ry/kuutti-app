import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AAGUID_DEVELOPMENT,
  appleExtensions,
  cbor,
  der,
  extension,
  makeIssuer,
  makePhone,
  makeRoot,
  nonceExtension,
  otherKeys,
} from "../test/app-attest.ts";
import { APPLE_SAMPLE, DEVICE_SAMPLE } from "../test/app-attest-samples.ts";
import {
  APPLE_APP_ATTEST_ROOT,
  type AppAttestConfig,
  AttestationError,
  type AttestationRefusal,
  clientDataHashOf,
  verifyAssertion,
  verifyAttestation,
} from "./app-attest.ts";

const APP_ID = "ABCDE12345.fi.kuutti.app";
const NOW = new Date("2026-11-10T12:00:00Z");
const HASH = clientDataHashOf("the one-time code");

const { root, issuer: rootIssuer } = makeRoot();
const authority = makeIssuer(rootIssuer, "Test App Attestation CA 1");
const config: AppAttestConfig = { appId: APP_ID, allowDevelopment: false, root };
const phone = makePhone({ issuer: authority, chain: [authority.certificate], appId: APP_ID });

/** The step that refused; fails when nothing did, or when something else was thrown. */
function refusal(run: () => unknown): AttestationRefusal {
  try {
    run();
  } catch (error) {
    if (error instanceof AttestationError) return error.reason;
    throw error;
  }
  throw new Error("nothing was refused");
}

const attest = (attestation: Buffer, over: Partial<Parameters<typeof verifyAttestation>[1]> = {}) =>
  verifyAttestation(config, {
    attestation,
    keyId: phone.keyId,
    clientDataHash: HASH,
    now: NOW,
    ...over,
  });

describe("Apple's root", () => {
  it("is the certificate Apple publishes, by its SHA-256 fingerprint", () => {
    expect(APPLE_APP_ATTEST_ROOT.fingerprint256).toBe(
      "1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32",
    );
    expect(APPLE_APP_ATTEST_ROOT.subject).toContain("Apple App Attestation Root CA");
  });
});

describe("the vendor's own bytes", () => {
  const apple = { appId: APPLE_SAMPLE.appId, allowDevelopment: false, root: APPLE_APP_ATTEST_ROOT };
  const appleInput = {
    attestation: Buffer.from(APPLE_SAMPLE.attestation, "base64"),
    keyId: Buffer.from(APPLE_SAMPLE.keyId, "base64"),
    clientDataHash: APPLE_SAMPLE.clientDataHash,
    now: APPLE_SAMPLE.at,
  };

  it("verifies Apple's worked example under Apple's root, and reads its two extensions", () => {
    const attested = verifyAttestation(apple, appleInput);
    expect(createHash("sha256").update(attested.publicKey).digest("base64")).toBe(
      APPLE_SAMPLE.keyId,
    );
    expect(attested.publicKey).toHaveLength(65);
    expect(attested.validationCategory).toBe(1);
    expect(attested.bundleVersion).toBe("1");
  });

  it("refuses Apple's example once its certificate has run out, and before it began", () => {
    expect(refusal(() => verifyAttestation(apple, { ...appleInput, now: NOW }))).toBe("expired");
    const before = new Date("2026-04-20T18:13:11Z");
    expect(refusal(() => verifyAttestation(apple, { ...appleInput, now: before }))).toBe("expired");
  });

  it("refuses Apple's example for another challenge, another app and another root", () => {
    const other = { ...appleInput, clientDataHash: clientDataHashOf("example_server_challenge") };
    expect(refusal(() => verifyAttestation(apple, other))).toBe("nonce");
    expect(refusal(() => verifyAttestation({ ...apple, appId: APP_ID }, appleInput))).toBe(
      "app_id",
    );
    expect(refusal(() => verifyAttestation({ ...apple, root }, appleInput))).toBe("certificate");
  });

  const device = {
    appId: DEVICE_SAMPLE.appId,
    allowDevelopment: true,
    root: APPLE_APP_ATTEST_ROOT,
  };
  const deviceInput = {
    attestation: Buffer.from(DEVICE_SAMPLE.attestation, "base64"),
    keyId: Buffer.from(DEVICE_SAMPLE.keyId, "base64"),
    clientDataHash: clientDataHashOf(DEVICE_SAMPLE.clientData),
    now: DEVICE_SAMPLE.at,
  };

  it("verifies a real iPhone's attestation from before iOS 27, which says nothing of the build", () => {
    const attested = verifyAttestation(device, deviceInput);
    expect(createHash("sha256").update(attested.publicKey).digest("base64")).toBe(
      DEVICE_SAMPLE.keyId,
    );
    expect(attested.validationCategory).toBeNull();
    expect(attested.bundleVersion).toBeNull();
  });

  it("refuses that iPhone's development key where development keys do not count", () => {
    const production = { ...device, allowDevelopment: false };
    expect(refusal(() => verifyAttestation(production, deviceInput))).toBe("environment");
  });

  it("verifies that iPhone's first assertion, and refuses it replayed, over other data and for another app", () => {
    const { publicKey } = verifyAttestation(device, deviceInput);
    const input = {
      assertion: Buffer.from(DEVICE_SAMPLE.assertion, "base64"),
      publicKey,
      clientDataHash: clientDataHashOf(DEVICE_SAMPLE.clientData),
      lastCounter: 0,
    };
    expect(verifyAssertion(device, input)).toEqual({ counter: 1 });
    expect(refusal(() => verifyAssertion(device, { ...input, lastCounter: 1 }))).toBe("counter");
    const otherData = { ...input, clientDataHash: clientDataHashOf("other") };
    expect(refusal(() => verifyAssertion(device, otherData))).toBe("signature");
    expect(refusal(() => verifyAssertion({ appId: APP_ID }, input))).toBe("app_id");
  });
});

describe("verifyAttestation", () => {
  it("answers the key of an attestation that meets every step", () => {
    expect(attest(phone.attest(HASH))).toEqual({
      publicKey: phone.point,
      validationCategory: null,
      bundleVersion: null,
    });
  });

  it("follows a chain of two authorities to the root", () => {
    const second = makeIssuer(authority, "Test App Attestation CA 2");
    const far = makePhone({
      issuer: second,
      chain: [second.certificate, authority.certificate],
      appId: APP_ID,
    });
    expect(attest(far.attest(HASH), { keyId: far.keyId }).publicKey).toEqual(far.point);
  });

  it.each([
    ["nothing at all", Buffer.alloc(0)],
    ["something that is no map", cbor(["apple-appattest"])],
    ["a map with bytes after it", Buffer.concat([phone.attest(HASH), Buffer.from([0])])],
    ["another format", phone.attest(HASH, { object: (f) => new Map(f).set("fmt", "packed") })],
    ["no statement", phone.attest(HASH, { object: (f) => new Map(f).set("attStmt", "none") })],
    ["certificates that are no list", phone.attest(HASH, { x5c: () => "none" as never })],
    ["one certificate", phone.attest(HASH, { x5c: (credential) => [credential] })],
    [
      "four certificates",
      phone.attest(HASH, { x5c: (c) => [c, authority.certificate, c, authority.certificate] }),
    ],
    ["a certificate that is no bytes", phone.attest(HASH, { x5c: (c) => [c, "text"] })],
    ["no authenticator data", phone.attest(HASH, { object: (f) => new Map(f).set("authData", 1) })],
    [
      "authenticator data that end before the key's identifier",
      phone.attest(HASH, { object: (f) => new Map(f).set("authData", Buffer.alloc(86)) }),
    ],
  ])("refuses the format of %s", (_, attestation) => {
    expect(refusal(() => attest(attestation))).toBe("format");
  });

  it.each([
    ["a tag", Buffer.from([0xc0, 0x00])],
    ["a float", Buffer.from([0xf9, 0x00, 0x00])],
    ["an indefinite length", Buffer.from([0xbf, 0xff])],
    ["a 64-bit length", Buffer.from([0x5b, 0, 0, 0, 0, 0, 0, 0, 1, 0])],
    ["a length whose bytes are cut off", Buffer.from([0x59, 0x01])],
    ["a byte string longer than what is left", Buffer.from([0xa1, 0x61, 0x61, 0x58, 0x40, 1, 2])],
    [
      "a list longer than what is left",
      Buffer.from([0xa1, 0x61, 0x61, 0x9a, 0xff, 0xff, 0xff, 0xff]),
    ],
    ["a map whose key is bytes", cbor(new Map([[Buffer.from("fmt"), "apple-appattest"]]))],
    ["a nesting deeper than any object of Apple's", cbor([[[[[[[[1]]]]]]]])],
    ["a negative number alone", cbor(-7)],
  ])("refuses CBOR with %s", (_, bytes) => {
    expect(refusal(() => attest(bytes))).toBe("format");
  });

  it("refuses a hundred thousand lists inside one another before the stack runs out", () => {
    // Each byte opens a list of one: without the bound on nesting this is a
    // RangeError out of the reader, not a refusal.
    expect(refusal(() => attest(Buffer.alloc(100_000, 0x81)))).toBe("format");
  });

  it("refuses certificates that are no certificates", () => {
    const junk = phone.attest(HASH, { x5c: (c) => [c, Buffer.from("no certificate")] });
    expect(refusal(() => attest(junk))).toBe("certificate");
  });

  it("refuses a credential certificate its issuer did not sign", () => {
    const forged = phone.attest(HASH, { signer: otherKeys().privateKey });
    expect(refusal(() => attest(forged))).toBe("certificate");
  });

  it("refuses a credential certificate that names another issuer", () => {
    const misnamed = phone.attest(HASH, { issuerName: "Somebody Else" });
    expect(refusal(() => attest(misnamed))).toBe("certificate");
  });

  it("refuses an issuer that is no authority", () => {
    const plain = makeIssuer(rootIssuer, "Not An Authority", { ca: false });
    const under = makePhone({ issuer: plain, chain: [plain.certificate], appId: APP_ID });
    expect(refusal(() => attest(under.attest(HASH), { keyId: under.keyId }))).toBe("certificate");
  });

  it("refuses a chain that leads to another root", () => {
    const elsewhere = makeRoot("Another Root");
    const theirs = makeIssuer(elsewhere.issuer, "Their CA");
    const under = makePhone({ issuer: theirs, chain: [theirs.certificate], appId: APP_ID });
    expect(refusal(() => attest(under.attest(HASH), { keyId: under.keyId }))).toBe("certificate");
    // And the same bytes under their own root are good: it was the root that refused.
    const accepted = verifyAttestation(
      { ...config, root: elsewhere.root },
      { attestation: under.attest(HASH), keyId: under.keyId, clientDataHash: HASH, now: NOW },
    );
    expect(accepted.publicKey).toEqual(under.point);
  });

  it.each([
    ["the credential certificate begins tomorrow", { notBefore: new Date("2026-11-11T00:00:00Z") }],
    ["the credential certificate ended yesterday", { notAfter: new Date("2026-11-09T00:00:00Z") }],
  ])("refuses as expired when %s", (_, validity) => {
    expect(refusal(() => attest(phone.attest(HASH, validity)))).toBe("expired");
  });

  it("refuses as expired when an authority's certificate has run out, and when the root's has", () => {
    const lapsed = makeIssuer(rootIssuer, "Lapsed CA", {
      notAfter: new Date("2026-01-01T00:00:00Z"),
    });
    const under = makePhone({ issuer: lapsed, chain: [lapsed.certificate], appId: APP_ID });
    expect(refusal(() => attest(under.attest(HASH), { keyId: under.keyId }))).toBe("expired");
    const afterTheRoot = new Date("2046-01-01T00:00:00Z");
    const longLived = phone.attest(HASH, { notAfter: new Date("2049-01-01T00:00:00Z") });
    expect(refusal(() => attest(longLived, { now: afterTheRoot }))).toBe("expired");
  });

  it("refuses a nonce made for another challenge", () => {
    expect(refusal(() => attest(phone.attest(clientDataHashOf("another code"))))).toBe("nonce");
  });

  it("refuses authenticator data changed after the certificate was issued", () => {
    const attestation = phone.attest(HASH);
    // The last byte of the authenticator data, which end the object: the key's y.
    const changed = Buffer.from(attestation);
    changed.writeUInt8(changed.readUInt8(changed.length - 1) ^ 1, changed.length - 1);
    expect(refusal(() => attest(changed))).toBe("nonce");
  });

  it.each([
    ["no extensions at all", () => []],
    ["extensions without Apple's", () => [extension("551d0e", der(0x04, Buffer.alloc(20)))]],
    [
      "a nonce outside a sequence",
      (nonce: Buffer) => [nonceExtension(der(0x31, der(0xa1, der(0x04, nonce))))],
    ],
    [
      "a nonce that is no octet string",
      (nonce: Buffer) => [nonceExtension(der(0x30, der(0xa1, der(0x0c, nonce))))],
    ],
  ])("refuses a credential certificate with %s", (_, extensions) => {
    expect(refusal(() => attest(phone.attest(HASH, { extensions })))).toBe("nonce");
  });

  it.each([
    ["nothing in it", Buffer.alloc(0)],
    ["a length that says more than there is", Buffer.from([0x30, 0x05, 0xa1, 0x00])],
    ["a length of no fixed size", Buffer.from([0x30, 0x80, 0x00, 0x00])],
    ["a length four bytes wide", Buffer.from([0x30, 0x84, 0, 0, 0, 1, 0])],
    ["a length whose bytes are cut off", Buffer.from([0x30, 0x82, 0x01])],
    ["a tag of many bytes", Buffer.from([0x30, 0x03, 0xbf, 0x89, 0x30])],
    // Every header is whole and in place; only the lengths lie, and would
    // take the certificate's next bytes for the nonce.
    [
      "lengths that reach past it into the certificate",
      Buffer.from([0x30, 0x24, 0xa1, 0x22, 0x04, 0x20, 0x01, 0x02]),
    ],
  ])("refuses a nonce extension with %s", (_, value) => {
    const attestation = phone.attest(HASH, { extensions: () => [nonceExtension(value)] });
    expect(refusal(() => attest(attestation))).toBe("certificate");
  });

  it("refuses a key that is not on P-256", () => {
    const attestation = phone.attest(HASH, { certifiedKey: otherKeys("secp384r1").publicKey });
    expect(refusal(() => attest(attestation))).toBe("key");
  });

  it("refuses a key identifier that is not the certified key's", () => {
    const attestation = phone.attest(HASH, { certifiedKey: otherKeys().publicKey });
    expect(refusal(() => attest(attestation))).toBe("key_id");
    expect(refusal(() => attest(phone.attest(HASH), { keyId: Buffer.alloc(32, 7) }))).toBe(
      "key_id",
    );
  });

  it("refuses another app's attestation", () => {
    const theirs = phone.attest(HASH, { appId: "ABCDE12345.fi.kuutti.other" });
    expect(refusal(() => attest(theirs))).toBe("app_id");
  });

  it("refuses a key that has already signed", () => {
    expect(refusal(() => attest(phone.attest(HASH, { counter: 1 })))).toBe("counter");
  });

  it("takes a development key only where development keys count", () => {
    const development = phone.attest(HASH, { aaguid: AAGUID_DEVELOPMENT });
    expect(refusal(() => attest(development))).toBe("environment");
    const lenient = { ...config, allowDevelopment: true };
    const input = { attestation: development, keyId: phone.keyId, clientDataHash: HASH, now: NOW };
    expect(verifyAttestation(lenient, input).publicKey).toEqual(phone.point);
    // And a production key counts there too.
    expect(
      verifyAttestation(lenient, { ...input, attestation: phone.attest(HASH) }).publicKey,
    ).toEqual(phone.point);
  });

  it.each([[false], [true]])(
    "refuses an environment that is neither of Apple's, development keys counting: %s",
    (allowDevelopment) => {
      const unknown = phone.attest(HASH, { aaguid: Buffer.from("appattestsandbox") });
      const input = { attestation: unknown, keyId: phone.keyId, clientDataHash: HASH, now: NOW };
      expect(refusal(() => verifyAttestation({ ...config, allowDevelopment }, input))).toBe(
        "environment",
      );
    },
  );

  it("refuses a credential that is not the key's identifier, in length or in value", () => {
    const longer = phone.attest(HASH, {
      credentialId: Buffer.concat([phone.keyId, Buffer.alloc(1)]),
    });
    expect(refusal(() => attest(longer))).toBe("credential_id");
    const other = phone.attest(HASH, { credentialId: Buffer.alloc(32, 7) });
    expect(refusal(() => attest(other))).toBe("credential_id");
  });

  it.each([[2], [3], [4], [5], [6], [10]])(
    "takes an app Apple says was launched in category %i, and says so",
    (category) => {
      const attested = attest(phone.attest(HASH, { afterKey: appleExtensions(category, "118") }));
      expect(attested).toEqual({
        publicKey: phone.point,
        validationCategory: category,
        bundleVersion: "118",
      });
    },
  );

  it.each([[0], [7], [8], [9]])(
    "refuses category %i, which no app a person runs has",
    (category) => {
      const attestation = phone.attest(HASH, { afterKey: appleExtensions(category) });
      expect(refusal(() => attest(attestation))).toBe("category");
    },
  );

  it.each([
    ["something that is no map", cbor("extensions")],
    ["a map without Apple's two", cbor(new Map([["other", 1]]))],
    [
      "a category that is no four bytes and a version that is no text",
      cbor(
        new Map<string, unknown>([
          ["apple_validation_category_01", 4],
          ["apple_bundle_version_01", Buffer.from("118")],
        ]),
      ),
    ],
    [
      "a category of three bytes",
      cbor(new Map([["apple_validation_category_01", Buffer.alloc(3)]])),
    ],
    ["bytes that are no CBOR", Buffer.from([0xff, 0xff])],
    [
      // A version of a hundred characters, three of them there: read as far
      // as it goes it would be a version nobody wrote.
      "a version whose length runs past the end",
      Buffer.concat([
        Buffer.from([0xa1, 0x77]),
        Buffer.from("apple_bundle_version_01"),
        Buffer.from([0x78, 0x64]),
        Buffer.from("118"),
      ]),
    ],
  ])("reads extensions that are %s as nothing said, and refuses nothing", (_, afterKey) => {
    expect(attest(phone.attest(HASH, { afterKey }))).toEqual({
      publicKey: phone.point,
      validationCategory: null,
      bundleVersion: null,
    });
  });

  it("reads a key it cannot parse as nothing said of the build: the certificate gave the key", () => {
    const attestation = phone.attest(HASH, { coseKey: Buffer.from([0xff]) });
    expect(attest(attestation).validationCategory).toBeNull();
  });
});

describe("verifyAssertion", () => {
  const assert = (
    assertion: Buffer,
    over: Partial<Parameters<typeof verifyAssertion>[1]> = {},
    appId = APP_ID,
  ) =>
    verifyAssertion(
      { appId },
      { assertion, publicKey: phone.point, clientDataHash: HASH, lastCounter: 0, ...over },
    );

  it("answers the counter of the key's signature over the client data", () => {
    expect(assert(phone.assert(HASH, 1))).toEqual({ counter: 1 });
    expect(assert(phone.assert(HASH, 4_000_000_000), { lastCounter: 3_999_999_999 })).toEqual({
      counter: 4_000_000_000,
    });
  });

  it.each([
    ["nothing at all", Buffer.alloc(0)],
    ["something that is no map", cbor("assertion")],
    ["a map with bytes after it", Buffer.concat([phone.assert(HASH, 1), Buffer.from([0])])],
    ["no signature", phone.assert(HASH, 1, { object: (f) => new Map(f).set("signature", "none") })],
    [
      "no authenticator data",
      phone.assert(HASH, 1, { object: (f) => new Map(f).set("authenticatorData", 1) }),
    ],
    [
      "authenticator data that end before the counter does",
      phone.assert(HASH, 1, {
        object: (f) => new Map(f).set("authenticatorData", Buffer.alloc(36)),
      }),
    ],
  ])("refuses the format of %s", (_, assertion) => {
    expect(refusal(() => assert(assertion))).toBe("format");
  });

  it("refuses a signature over other client data", () => {
    expect(refusal(() => assert(phone.assert(clientDataHashOf("another token"), 1)))).toBe(
      "signature",
    );
  });

  it("refuses another key's signature", () => {
    const forged = phone.assert(HASH, 1, { signer: otherKeys().privateKey });
    expect(refusal(() => assert(forged))).toBe("signature");
  });

  it("refuses a signature that is no signature", () => {
    const junk = phone.assert(HASH, 1, {
      object: (f) => new Map(f).set("signature", Buffer.from("no")),
    });
    expect(refusal(() => assert(junk))).toBe("signature");
  });

  it("refuses authenticator data changed after signing", () => {
    const raised = phone.assert(HASH, 1, {
      object: (fields) => {
        const data = Buffer.from(fields.get("authenticatorData") as Buffer);
        data.writeUInt32BE(9, 33);
        return new Map(fields).set("authenticatorData", data);
      },
    });
    expect(refusal(() => assert(raised))).toBe("signature");
  });

  it("refuses when the key it kept is no point of the curve", () => {
    expect(refusal(() => assert(phone.assert(HASH, 1), { publicKey: Buffer.alloc(65, 1) }))).toBe(
      "signature",
    );
    expect(refusal(() => assert(phone.assert(HASH, 1), { publicKey: Buffer.alloc(3) }))).toBe(
      "signature",
    );
  });

  it("refuses an assertion made for another app", () => {
    const theirs = phone.assert(HASH, 1, { appId: "ABCDE12345.fi.kuutti.other" });
    expect(refusal(() => assert(theirs))).toBe("app_id");
  });

  it.each([
    [1, 1],
    [1, 2],
    [0, 0],
  ])("refuses counter %i after %i", (counter, lastCounter) => {
    expect(refusal(() => assert(phone.assert(HASH, counter), { lastCounter }))).toBe("counter");
  });
});

describe("whatever bytes arrive", () => {
  const SEEDED = { seed: 20261110 };
  const bytes = fc.uint8Array({ maxLength: 512 }).map((array) => Buffer.from(array));

  it("an attestation of any bytes is refused, and with nothing but a refusal", () => {
    fc.assert(
      fc.property(bytes, (attestation) => {
        expect(() => attest(attestation)).toThrow(AttestationError);
      }),
      SEEDED,
    );
  });

  it("an assertion of any bytes is refused, and with nothing but a refusal", () => {
    fc.assert(
      fc.property(bytes, (assertion) => {
        expect(() =>
          verifyAssertion(
            { appId: APP_ID },
            { assertion, publicKey: phone.point, clientDataHash: HASH, lastCounter: 0 },
          ),
        ).toThrow(AttestationError);
      }),
      SEEDED,
    );
  });

  it("a good attestation cut short anywhere is refused", () => {
    const whole = phone.attest(HASH, { afterKey: appleExtensions(4) });
    fc.assert(
      fc.property(fc.nat({ max: whole.length - 1 }), (length) => {
        expect(() => attest(whole.subarray(0, length))).toThrow(AttestationError);
      }),
      SEEDED,
    );
  });

  it("a good attestation with any bit of its authenticator data flipped is refused", () => {
    const whole = phone.attest(HASH, { afterKey: appleExtensions(4) });
    // The authenticator data are the object's last field: 32 + 1 + 4 + 16 + 2 + 32 bytes, the key's 77 and the extensions.
    const length = 87 + 77 + appleExtensions(4).length;
    fc.assert(
      fc.property(fc.nat({ max: length * 8 - 1 }), (bit) => {
        const changed = Buffer.from(whole);
        const at = whole.length - length + (bit >> 3);
        changed.writeUInt8(changed.readUInt8(at) ^ (1 << (bit & 7)), at);
        expect(() => attest(changed)).toThrow(AttestationError);
      }),
      SEEDED,
    );
  });

  it("a good assertion with any bit flipped is refused", () => {
    const whole = phone.assert(HASH, 1);
    fc.assert(
      fc.property(fc.nat({ max: whole.length * 8 - 1 }), (bit) => {
        const changed = Buffer.from(whole);
        changed.writeUInt8(changed.readUInt8(bit >> 3) ^ (1 << (bit & 7)), bit >> 3);
        expect(() =>
          verifyAssertion(
            { appId: APP_ID },
            { assertion: changed, publicKey: phone.point, clientDataHash: HASH, lastCounter: 0 },
          ),
        ).toThrow(AttestationError);
      }),
      SEEDED,
    );
  });
});
