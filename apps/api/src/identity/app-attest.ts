import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  X509Certificate,
} from "node:crypto";

// Apple's App Attest, the server's half (ADR-069). An attestation says that a
// key lives in the Secure Enclave of an Apple device and was made there by an
// app signed as ours; an assertion is that key's signature over what a later
// request carries. The steps and their numbers are Apple's ("Validating apps
// that connect to your server", read 10/11/2026): eleven for an attestation,
// six of the eight for an assertion (§3 says why two are left). Everything here
// is computation over the bytes given: no network, no clock but the caller's,
// and nothing but node:crypto.

/**
 * Apple App Attestation Root CA as Apple publishes it
 * (https://www.apple.com/certificateauthority/private/), DER in base64: valid
 * from 18/03/2020 to 15/03/2045. `app-attest.test.ts` holds it to its SHA-256
 * fingerprint and to Apple's own sample.
 */
const APPLE_ROOT_DER =
  "MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRp" +
  "b24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNaFw00NTAz" +
  "MTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlvbiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMw" +
  "EQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdhNbJhFs/Ii2FdCgAH" +
  "GbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9auYen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMB" +
  "Af8EBTADAQH/MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaAAwZQIw" +
  "QgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpq" +
  "tijVoyFraWVIyd/dganmrduC1bmTBGwD";

export const APPLE_APP_ATTEST_ROOT = new X509Certificate(Buffer.from(APPLE_ROOT_DER, "base64"));

/** Which step refused: the log's word, never the caller's. */
export type AttestationRefusal =
  | "format"
  | "certificate"
  | "expired"
  | "nonce"
  | "key"
  | "key_id"
  | "app_id"
  | "counter"
  | "environment"
  | "credential_id"
  | "category"
  | "signature";

export class AttestationError extends Error {
  constructor(readonly reason: AttestationRefusal) {
    super(`not attested: ${reason}`);
    this.name = "AttestationError";
  }
}

export type AppAttestConfig = {
  /** The App ID: the team's prefix, a period and the bundle identifier. */
  appId: string;
  /** Whether a key of Apple's development environment counts: never in production. */
  allowDevelopment: boolean;
  /** Apple's root; a test's own in tests. */
  root: X509Certificate;
};

export type Attested = {
  /** The attested key as an X9.62 uncompressed point, 65 bytes: what an assertion is verified with. */
  publicKey: Buffer;
  /** How Apple says the app was launched, on iOS 27 and later (step 10); null before. */
  validationCategory: number | null;
  /** The app's bundle version as Apple read it, on iOS 27 and later (step 11); null before. */
  bundleVersion: string | null;
};

function sha256(...parts: (Buffer | string)[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

/**
 * What the phone hands Apple as `clientDataHash` for a challenge: the SHA-256
 * of its characters, as Expo's module computes it before either call
 * (`@expo/app-integrity` 57.0.2, `IntegrityModule.swift`).
 */
export function clientDataHashOf(challenge: string): Buffer {
  return sha256(challenge);
}

// --- CBOR (RFC 8949), only what Apple's two objects are made of -------------

type Cbor = number | string | Buffer | Cbor[] | Map<number | string, Cbor>;

/** Deeper than either object goes: a map, its statement, the certificates, a certificate. */
const CBOR_MAX_DEPTH = 6;

/**
 * One item at `at`. Unsigned and negative integers, byte and text strings,
 * arrays and maps of definite length up to 32 bits; a tag, a float, a simple
 * value, an indefinite or 64-bit length, a length past the end and a nesting
 * past the depth are all refused, so no input makes it read or loop beyond its
 * own bytes.
 */
function readCbor(data: Buffer, at: number, depth: number): { value: Cbor; end: number } {
  if (depth > CBOR_MAX_DEPTH || at >= data.length) throw new AttestationError("format");
  const head = data.readUInt8(at);
  const major = head >> 5;
  const info = head & 0x1f;
  const wide = info < 24 ? 0 : info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : -1;
  let next = at + 1 + wide;
  if (wide < 0 || next > data.length) throw new AttestationError("format");
  const argument = wide === 0 ? info : data.readUIntBE(at + 1, wide);
  if (major === 0) return { value: argument, end: next };
  if (major === 1) return { value: -1 - argument, end: next };
  // Every item takes a byte at least, so a count or a length past what is left
  // is refused before anything is read or allocated for it.
  if (major > 5 || argument > data.length - next) throw new AttestationError("format");
  if (major === 2 || major === 3) {
    const bytes = data.subarray(next, next + argument);
    return { value: major === 2 ? bytes : bytes.toString("utf8"), end: next + argument };
  }
  if (major === 4) {
    const items: Cbor[] = [];
    for (let i = 0; i < argument; i++) {
      const item = readCbor(data, next, depth + 1);
      items.push(item.value);
      next = item.end;
    }
    return { value: items, end: next };
  }
  const map = new Map<number | string, Cbor>();
  for (let i = 0; i < argument; i++) {
    const key = readCbor(data, next, depth + 1);
    if (typeof key.value !== "number" && typeof key.value !== "string") {
      throw new AttestationError("format");
    }
    const value = readCbor(data, key.end, depth + 1);
    map.set(key.value, value.value);
    next = value.end;
  }
  return { value: map, end: next };
}

/** An object that is one CBOR map and nothing after it. */
function readObject(data: Buffer): Map<number | string, Cbor> {
  const { value, end } = readCbor(data, 0, 0);
  if (!(value instanceof Map) || end !== data.length) throw new AttestationError("format");
  return value;
}

// --- DER, only to reach one extension of a certificate ----------------------

type Tlv = { tag: number; start: number; end: number };

/** The element at `at`, inside `limit`: one tag byte, a definite length of up to three bytes. */
function readTlv(data: Buffer, at: number, limit: number): Tlv {
  if (at + 2 > limit) throw new AttestationError("certificate");
  const tag = data.readUInt8(at);
  const first = data.readUInt8(at + 1);
  const wide = first < 0x80 ? 0 : first & 0x7f;
  const start = at + 2 + wide;
  if ((tag & 0x1f) === 0x1f || wide > 3 || (first >= 0x80 && wide === 0) || start > limit) {
    throw new AttestationError("certificate");
  }
  const length = wide === 0 ? first : data.readUIntBE(at + 2, wide);
  if (start + length > limit) throw new AttestationError("certificate");
  return { tag, start, end: start + length };
}

function childrenOf(data: Buffer, parent: Tlv): Tlv[] {
  const children: Tlv[] = [];
  for (let at = parent.start; at < parent.end; ) {
    const child = readTlv(data, at, parent.end);
    children.push(child);
    at = child.end;
  }
  return children;
}

const SEQUENCE = 0x30;
const OCTET_STRING = 0x04;
const OBJECT_IDENTIFIER = 0x06;
/** `[3] EXPLICIT Extensions` of a TBSCertificate (RFC 5280 §4.1). */
const EXTENSIONS = 0xa3;
/** 1.2.840.113635.100.8.2, the extension that carries the nonce (step 4). */
const NONCE_OID = Buffer.from("2a864886f763640802", "hex");

/**
 * The nonce Apple put in the credential certificate: the extension's value is
 * a sequence of one tagged element holding one octet string (step 4). The
 * certificate has been parsed by then, so its outer shape is sound; the walk
 * still reads nothing past a length.
 */
function nonceOf(certificate: Buffer): Buffer {
  const whole = readTlv(certificate, 0, certificate.length);
  const tbs = readTlv(certificate, whole.start, whole.end);
  const extensions = childrenOf(certificate, tbs).find((field) => field.tag === EXTENSIONS);
  if (!extensions) throw new AttestationError("nonce");
  const list = readTlv(certificate, extensions.start, extensions.end);
  for (const extension of childrenOf(certificate, list)) {
    const fields = childrenOf(certificate, extension);
    const id = fields[0];
    const value = fields[fields.length - 1];
    if (
      id?.tag !== OBJECT_IDENTIFIER ||
      value?.tag !== OCTET_STRING ||
      !certificate.subarray(id.start, id.end).equals(NONCE_OID)
    ) {
      continue;
    }
    const sequence = readTlv(certificate, value.start, value.end);
    const tagged = readTlv(certificate, sequence.start, sequence.end);
    const octets = readTlv(certificate, tagged.start, tagged.end);
    if (sequence.tag !== SEQUENCE || octets.tag !== OCTET_STRING) break;
    return certificate.subarray(octets.start, octets.end);
  }
  throw new AttestationError("nonce");
}

// --- The certificates --------------------------------------------------------

/** The credential certificate and at most two authorities between it and the root. */
const CHAIN_MAX = 3;

/**
 * Step 1: the certificates the object carries, the credential certificate
 * first, each issued and signed by the next and the last by the root, every
 * issuer an authority, and all of them, the root included, valid at `now`.
 * Answers the credential certificate.
 */
function credentialCertificate(x5c: Buffer[], root: X509Certificate, now: Date): X509Certificate {
  let certificates: X509Certificate[];
  try {
    certificates = x5c.map((der) => new X509Certificate(der));
  } catch {
    throw new AttestationError("certificate");
  }
  let issuer = root;
  for (const certificate of certificates.toReversed()) {
    if (!issuer.ca || !certificate.checkIssued(issuer) || !certificate.verify(issuer.publicKey)) {
      throw new AttestationError("certificate");
    }
    issuer = certificate;
  }
  for (const certificate of [root, ...certificates]) {
    if (now < certificate.validFromDate || now > certificate.validToDate) {
      throw new AttestationError("expired");
    }
  }
  return issuer;
}

/** What precedes the point in the SubjectPublicKeyInfo of a P-256 key: 26 bytes, always these. */
const P256_SPKI_HEAD = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
const POINT_BYTES = 65;

/** The certificate's key as an X9.62 uncompressed point (step 5), which is how its SPKI ends. */
function pointOf(certificate: X509Certificate): Buffer {
  const key = certificate.publicKey;
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new AttestationError("key");
  }
  const spki = key.export({ type: "spki", format: "der" });
  return spki.subarray(spki.length - POINT_BYTES);
}

// --- The authenticator data --------------------------------------------------

// rpIdHash (32), flags (1), counter (4), then, in an attestation alone: aaguid
// (16), the credential id's length (2), the credential id, the key in COSE
// and, from iOS 27, a CBOR map of extensions.
const COUNTER_AT = 33;
const AAGUID_AT = 37;
const CREDENTIAL_LENGTH_AT = 53;
const CREDENTIAL_AT = 55;
const KEY_ID_BYTES = 32;

const AAGUID_PRODUCTION = Buffer.concat([Buffer.from("appattest"), Buffer.alloc(7)]);
const AAGUID_DEVELOPMENT = Buffer.from("appattestdevelop");

/** Step 10's categories Apple calls invalid or "not appropriate": no app a person runs has them. */
const REFUSED_CATEGORIES: ReadonlySet<number> = new Set([0, 7, 8, 9]);

/**
 * Steps 10 and 11: what follows the key, if anything does. Apple signs these
 * bytes with the rest (the nonce covers them), so a shape this code does not
 * know is Apple's newer one and not an attack: it reads as nothing said, and
 * never refuses a sign-in.
 */
function extensionsOf(
  authData: Buffer,
  at: number,
): Pick<Attested, "validationCategory" | "bundleVersion"> {
  const none = { validationCategory: null, bundleVersion: null };
  try {
    const key = readCbor(authData, at, 0);
    if (key.end === authData.length) return none;
    const { value } = readCbor(authData, key.end, 0);
    if (!(value instanceof Map)) return none;
    const category = value.get("apple_validation_category_01");
    const version = value.get("apple_bundle_version_01");
    return {
      // A UInt32 as Apple's sample writes it: four bytes, the low one first.
      validationCategory:
        Buffer.isBuffer(category) && category.length === 4 ? category.readUInt32LE(0) : null,
      bundleVersion: typeof version === "string" ? version : null,
    };
  } catch {
    return none;
  }
}

/**
 * Verifies an attestation object against the client data hash it was asked
 * for (the challenge's, `clientDataHashOf`) and the key identifier the app
 * sent with it. Throws `AttestationError` naming the step that refused.
 */
export function verifyAttestation(
  config: AppAttestConfig,
  input: { attestation: Buffer; keyId: Buffer; clientDataHash: Buffer; now: Date },
): Attested {
  const object = readObject(input.attestation);
  const statement = object.get("attStmt");
  const x5c = statement instanceof Map ? statement.get("x5c") : undefined;
  const authData = object.get("authData");
  if (
    object.get("fmt") !== "apple-appattest" ||
    !Array.isArray(x5c) ||
    x5c.length < 2 ||
    x5c.length > CHAIN_MAX ||
    !x5c.every((certificate) => Buffer.isBuffer(certificate)) ||
    !Buffer.isBuffer(authData) ||
    authData.length < CREDENTIAL_AT + KEY_ID_BYTES
  ) {
    throw new AttestationError("format");
  }
  // 1
  const credential = credentialCertificate(x5c, config.root, input.now);
  // 2 to 4: the certificate was issued for these authenticator data and this challenge.
  const nonce = sha256(authData, input.clientDataHash);
  if (!nonceOf(credential.raw).equals(nonce)) throw new AttestationError("nonce");
  // 5
  const publicKey = pointOf(credential);
  if (!sha256(publicKey).equals(input.keyId)) throw new AttestationError("key_id");
  // 6
  if (!authData.subarray(0, 32).equals(sha256(config.appId))) throw new AttestationError("app_id");
  // 7
  if (authData.readUInt32BE(COUNTER_AT) !== 0) throw new AttestationError("counter");
  // 8
  const aaguid = authData.subarray(AAGUID_AT, CREDENTIAL_LENGTH_AT);
  const development = config.allowDevelopment && aaguid.equals(AAGUID_DEVELOPMENT);
  if (!development && !aaguid.equals(AAGUID_PRODUCTION)) throw new AttestationError("environment");
  // 9
  const credentialId = authData.subarray(CREDENTIAL_AT, CREDENTIAL_AT + KEY_ID_BYTES);
  if (
    authData.readUInt16BE(CREDENTIAL_LENGTH_AT) !== KEY_ID_BYTES ||
    !credentialId.equals(input.keyId)
  ) {
    throw new AttestationError("credential_id");
  }
  // 10 and 11
  const extensions = extensionsOf(authData, CREDENTIAL_AT + KEY_ID_BYTES);
  if (
    extensions.validationCategory !== null &&
    REFUSED_CATEGORIES.has(extensions.validationCategory)
  ) {
    throw new AttestationError("category");
  }
  return { publicKey, ...extensions };
}

/**
 * Verifies an assertion: the attested key's signature over a client data hash,
 * by an app with our App ID, with a counter past the last one seen. Answers
 * the counter to keep. Throws `AttestationError` naming the step that refused.
 */
export function verifyAssertion(
  config: Pick<AppAttestConfig, "appId">,
  input: { assertion: Buffer; publicKey: Buffer; clientDataHash: Buffer; lastCounter: number },
): { counter: number } {
  const object = readObject(input.assertion);
  const signature = object.get("signature");
  const authenticatorData = object.get("authenticatorData");
  if (
    !Buffer.isBuffer(signature) ||
    !Buffer.isBuffer(authenticatorData) ||
    authenticatorData.length < AAGUID_AT
  ) {
    throw new AttestationError("format");
  }
  // 1 to 3. The key signs the nonce as a message, so it is hashed once more
  // under the signature (ECDSA with SHA-256).
  const nonce = sha256(authenticatorData, input.clientDataHash);
  let signed: boolean;
  try {
    const key = createPublicKey({
      key: Buffer.concat([P256_SPKI_HEAD, input.publicKey]),
      format: "der",
      type: "spki",
    });
    signed = verifySignature("sha256", nonce, key, signature);
  } catch {
    // A stored key that is no point of the curve: nothing it signed can be told.
    signed = false;
  }
  if (!signed) throw new AttestationError("signature");
  // 4
  if (!authenticatorData.subarray(0, 32).equals(sha256(config.appId))) {
    throw new AttestationError("app_id");
  }
  // 5
  const counter = authenticatorData.readUInt32BE(COUNTER_AT);
  if (counter <= input.lastCounter) throw new AttestationError("counter");
  return { counter };
}
