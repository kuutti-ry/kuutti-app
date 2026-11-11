import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";

// A test's own App Attest (ADR-069): an authority that issues what Apple's
// does, and a phone that attests and asserts with a key of its own, so that
// every step of the verifier can be met, and failed, on purpose. Certificates
// and CBOR are written here by hand, as `identity/app-attest.ts` reads them.

const sha256 = (...parts: Buffer[]): Buffer => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

// --- DER ---------------------------------------------------------------------

/** One element: a tag, a definite length, the content. */
export function der(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  const length =
    body.length < 0x80
      ? Buffer.from([body.length])
      : body.length < 0x100
        ? Buffer.from([0x81, body.length])
        : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

const oid = (hex: string): Buffer => der(0x06, Buffer.from(hex, "hex"));
const ECDSA_WITH_SHA256 = der(0x30, oid("2a8648ce3d040302"));
const nameOf = (commonName: string): Buffer =>
  der(0x30, der(0x31, der(0x30, oid("550403"), der(0x0c, Buffer.from(commonName)))));
/** A UTCTime, which serves until 2049. */
const timeOf = (date: Date): Buffer =>
  der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));

/** An extension of a certificate: its identifier and its value, opaque to whoever parses the certificate. */
export function extension(oidHex: string, value: Buffer, critical = false): Buffer {
  return der(
    0x30,
    oid(oidHex),
    ...(critical ? [der(0x01, Buffer.from([0xff]))] : []),
    der(0x04, value),
  );
}

/** What makes a certificate an authority's. */
const CA_EXTENSION = extension("551d13", der(0x30, der(0x01, Buffer.from([0xff]))), true);
/** The extension Apple puts the nonce in (1.2.840.113635.100.8.2), around any value. */
export const nonceExtension = (value: Buffer): Buffer => extension("2a864886f763640802", value);
/** Its value as Apple writes it: a sequence of one tagged element holding the nonce. */
const nonceValue = (nonce: Buffer): Buffer => der(0x30, der(0xa1, der(0x04, nonce)));

/** Valid on any day a test runs until 2045, as Apple's root is. */
const NOT_BEFORE = new Date("2020-01-01T00:00:00Z");
const NOT_AFTER = new Date("2045-01-01T00:00:00Z");

/** An X.509 certificate signed with ECDSA and SHA-256. */
function certificate(input: {
  subject: string;
  issuer: string;
  /** The subject's public key. */
  key: KeyObject;
  /** The issuer's private key. */
  signer: KeyObject;
  extensions?: Buffer[];
  notBefore?: Date;
  notAfter?: Date;
}): Buffer {
  const serial = randomBytes(8);
  serial[0] = (serial.readUInt8(0) & 0x7f) | 0x01;
  const extensions = input.extensions ?? [];
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    ECDSA_WITH_SHA256,
    nameOf(input.issuer),
    der(0x30, timeOf(input.notBefore ?? NOT_BEFORE), timeOf(input.notAfter ?? NOT_AFTER)),
    nameOf(input.subject),
    input.key.export({ type: "spki", format: "der" }),
    ...(extensions.length > 0 ? [der(0xa3, der(0x30, ...extensions))] : []),
  );
  const signature = sign("sha256", tbs, input.signer);
  return der(0x30, tbs, ECDSA_WITH_SHA256, der(0x03, Buffer.from([0]), signature));
}

const newKeys = (curve = "prime256v1") => generateKeyPairSync("ec", { namedCurve: curve });

/** Somebody who signs certificates: its name, its private key and its own certificate. */
type Issuer = { name: string; key: KeyObject; certificate: Buffer };

/** A root of a test's own, and the issuer it is. */
export function makeRoot(name = "Test App Attestation Root CA"): {
  root: X509Certificate;
  issuer: Issuer;
} {
  const { publicKey, privateKey } = newKeys();
  const own = certificate({
    subject: name,
    issuer: name,
    key: publicKey,
    signer: privateKey,
    extensions: [CA_EXTENSION],
  });
  return { root: new X509Certificate(own), issuer: { name, key: privateKey, certificate: own } };
}

/** An authority under `parent`, as Apple's "App Attestation CA 1" is under its root; `ca: false` makes one that is none. */
export function makeIssuer(
  parent: Issuer,
  name: string,
  options: { ca?: boolean; notBefore?: Date; notAfter?: Date } = {},
): Issuer {
  const { publicKey, privateKey } = newKeys();
  return {
    name,
    key: privateKey,
    certificate: certificate({
      subject: name,
      issuer: parent.name,
      key: publicKey,
      signer: parent.key,
      extensions: options.ca === false ? [] : [CA_EXTENSION],
      notBefore: options.notBefore,
      notAfter: options.notAfter,
    }),
  };
}

// --- CBOR --------------------------------------------------------------------

function head(major: number, argument: number): Buffer {
  if (argument < 24) return Buffer.from([(major << 5) | argument]);
  if (argument < 0x100) return Buffer.from([(major << 5) | 24, argument]);
  const wide = Buffer.alloc(argument < 0x10000 ? 3 : 5);
  wide.writeUInt8((major << 5) | (argument < 0x10000 ? 25 : 26));
  if (argument < 0x10000) wide.writeUInt16BE(argument, 1);
  else wide.writeUInt32BE(argument, 1);
  return wide;
}

/** Integers, byte and text strings, arrays and maps: what Apple's objects hold. */
export function cbor(value: unknown): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === "string") {
    const text = Buffer.from(value);
    return Buffer.concat([head(3, text.length), text]);
  }
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  if (value instanceof Map) {
    const entries = [...value].flatMap(([key, item]) => [cbor(key), cbor(item)]);
    return Buffer.concat([head(5, value.size), ...entries]);
  }
  throw new Error("not something this encoder writes");
}

// --- A phone -----------------------------------------------------------------

const AAGUID_PRODUCTION = Buffer.concat([Buffer.from("appattest"), Buffer.alloc(7)]);
export const AAGUID_DEVELOPMENT = Buffer.from("appattestdevelop");

/** The extensions iOS 27 adds after the key: the launch category as a UInt32, the bundle version. */
export function appleExtensions(category: number, bundleVersion = "42"): Buffer {
  const value = Buffer.alloc(4);
  value.writeUInt32LE(category);
  return cbor(
    new Map<string, unknown>([
      ["apple_bundle_version_01", bundleVersion],
      ["apple_validation_category_01", value],
    ]),
  );
}

/** What a real phone would have made, altered where a test says so. */
type AttestChange = {
  appId?: string;
  counter?: number;
  aaguid?: Buffer;
  credentialId?: Buffer;
  credentialLength?: number;
  /** The key in COSE; a real one when absent. */
  coseKey?: Buffer;
  /** What follows the key: iOS 27's extensions. Nothing when absent, as before iOS 27. */
  afterKey?: Buffer;
  /** The credential certificate's extensions, given the true nonce; Apple's one when absent. */
  extensions?: (nonce: Buffer) => Buffer[];
  /** The key the credential certificate names; the phone's when absent. */
  certifiedKey?: KeyObject;
  /** Who signs the credential certificate, and under which name; the issuer when absent. */
  signer?: KeyObject;
  issuerName?: string;
  notBefore?: Date;
  notAfter?: Date;
  /** The certificates of the statement, given the credential certificate. */
  x5c?: (credential: Buffer) => unknown[];
  /** The object itself, given its three fields. */
  object?: (fields: Map<string, unknown>) => unknown;
};

/** What the attestation's and the assertion's authenticator data begin with: the App ID's hash, the flags, the counter. */
function authenticatorHead(appId: string, counter: number): Buffer {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(counter);
  return Buffer.concat([sha256(Buffer.from(appId)), Buffer.from([0x40]), count]);
}

/**
 * A phone with one App Attest key, whose attestations `issuer` signs and
 * `chain` leads to the root from (the issuer's certificate first).
 */
export function makePhone(input: { issuer: Issuer; chain: Buffer[]; appId: string }) {
  const { publicKey, privateKey } = newKeys();
  const spki = publicKey.export({ type: "spki", format: "der" });
  const point = spki.subarray(spki.length - 65);
  const keyId = sha256(point);
  const coseKey = cbor(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, point.subarray(1, 33)],
      [-3, point.subarray(33)],
    ]),
  );

  return {
    /** The key's identifier as the phone sends it. */
    keyId,
    /** The key's public half, as the server keeps it. */
    point,

    /** An attestation object over `clientDataHash`. */
    attest(clientDataHash: Buffer, change: AttestChange = {}): Buffer {
      const credentialId = change.credentialId ?? keyId;
      const credentialLength = Buffer.alloc(2);
      credentialLength.writeUInt16BE(change.credentialLength ?? credentialId.length);
      const authData = Buffer.concat([
        authenticatorHead(change.appId ?? input.appId, change.counter ?? 0),
        change.aaguid ?? AAGUID_PRODUCTION,
        credentialLength,
        credentialId,
        change.coseKey ?? coseKey,
        change.afterKey ?? Buffer.alloc(0),
      ]);
      const nonce = sha256(authData, clientDataHash);
      const credential = certificate({
        subject: keyId.toString("hex"),
        issuer: change.issuerName ?? input.issuer.name,
        key: change.certifiedKey ?? publicKey,
        signer: change.signer ?? input.issuer.key,
        extensions: change.extensions?.(nonce) ?? [nonceExtension(nonceValue(nonce))],
        notBefore: change.notBefore,
        notAfter: change.notAfter,
      });
      const fields = new Map<string, unknown>([
        ["fmt", "apple-appattest"],
        [
          "attStmt",
          new Map<string, unknown>([
            ["x5c", change.x5c?.(credential) ?? [credential, ...input.chain]],
            ["receipt", Buffer.from("a receipt nobody reads")],
          ]),
        ],
        ["authData", authData],
      ]);
      return cbor(change.object?.(fields) ?? fields);
    },

    /** An assertion over `clientDataHash`, the key's `counter`th. */
    assert(
      clientDataHash: Buffer,
      counter: number,
      change: {
        appId?: string;
        signer?: KeyObject;
        object?: (fields: Map<string, unknown>) => unknown;
      } = {},
    ): Buffer {
      const authenticatorData = authenticatorHead(change.appId ?? input.appId, counter);
      const nonce = sha256(authenticatorData, clientDataHash);
      const fields = new Map<string, unknown>([
        ["signature", sign("sha256", nonce, change.signer ?? privateKey)],
        ["authenticatorData", authenticatorData],
      ]);
      return cbor(change.object?.(fields) ?? fields);
    },
  };
}

/** A key pair on a curve of the caller's choice, for a certificate or a signature that should not fit. */
export const otherKeys = newKeys;
