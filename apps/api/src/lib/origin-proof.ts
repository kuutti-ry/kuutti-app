import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Kuutti's own CloudFront distribution proves that a request came through it
 * (ADR-066): a CloudFront Function puts the store's secret in this header on
 * every request of the default behaviour, after removing any value the viewer
 * sent. The box admits CloudFront's servers alone, but those are every
 * distribution's (ADR-008, History), so nothing else tells Kuutti's apart.
 */
export const ORIGIN_PROOF_HEADER = "x-kuutti-origin";

/**
 * What a request's header says: `valid` when it matches a configured secret,
 * `missing` or `wrong` when not, `unset` when no secret is configured at all.
 */
export type OriginProof = "valid" | "missing" | "wrong" | "unset";

/**
 * A checker for the configured secrets: one, or two while one replaces the
 * other (docs/runbooks/rotation.md). Each secret is compared by its SHA-256
 * digest in constant time, every one of them every time, so the time taken
 * says neither how long the header was nor which secret matched.
 */
export function originProofOf(
  secrets: readonly string[],
): (header: string | undefined) => OriginProof {
  const digests = secrets.map(digest);
  return (header) => {
    if (digests.length === 0) return "unset";
    if (header === undefined || header === "") return "missing";
    const given = digest(header);
    let valid = false;
    for (const expected of digests) valid = timingSafeEqual(given, expected) || valid;
    return valid ? "valid" : "wrong";
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
