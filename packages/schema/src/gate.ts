import { z } from "zod";

/**
 * Whether matching is open for the person, as they are told it (#500,
 * ADR-060 §4): three things, and no number, no step and no place.
 *
 * - `incomplete`: the profile or onboarding lacks something.
 * - `closed`: complete, and matching has not opened in the person's pond yet.
 * - `open`: matching is open.
 */
const GATE_STATES = ["incomplete", "closed", "open"] as const;
export const GateState = z.enum(GATE_STATES).meta({ id: "GateState" });
export type GateState = z.infer<typeof GateState>;

export const GateResponse = z.object({ state: GateState }).strict().meta({ id: "GateResponse" });
export type GateResponse = z.infer<typeof GateResponse>;
