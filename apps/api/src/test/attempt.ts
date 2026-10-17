import { createHash } from "node:crypto";

/**
 * One fixed verifier and its challenge, as the app makes them for a sign-in
 * attempt (ADR-027): the start carries the challenge, the exchange the
 * verifier. Fixed so that a test which starts in one helper and exchanges in
 * another needs to carry nothing between them; a test of a wrong verifier
 * makes its own.
 */
export const VERIFIER = "5a1e".repeat(16);
export const CHALLENGE = createHash("sha256").update(VERIFIER).digest("hex");
