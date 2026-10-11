import { z } from "zod";
import { WAITLIST_K_MIN } from "./waitlist.ts";

/**
 * The pond gate as the person is told it (#94, ADR-015; TD-10): where they
 * stand between a finished profile and their first round.
 *
 * - `incomplete`: the profile or onboarding lacks something; nothing is
 *   counted for the person yet.
 * - `pending`: complete, and where they stand is decided by the next count.
 * - `waiting`: in the pond's line; the person is among the next `within`.
 * - `closed`: let into the pond; matching opens when about `needed` more
 *   people who match the person's preferences, and whose preferences the
 *   person matches, are there.
 * - `open`: matching is open.
 *
 * `within` and `needed` are said in steps of `step` people, never exactly
 * (ADR-015 §6): an exact figure would answer what a person asks of it about
 * one other person. One flat object, not a union: the OpenAPI generator
 * turns a union into a type the client cannot narrow (see `WaitlistPond`).
 */
const GATE_STATES = ["incomplete", "pending", "waiting", "closed", "open"] as const;
export const GateState = z.enum(GATE_STATES).meta({ id: "GateState" });
export type GateState = z.infer<typeof GateState>;

export const GateResponse = z
  .object({
    state: GateState,
    /** The person is among the next `within` of the line; null unless `waiting`. */
    within: z.int().min(1).nullable(),
    /** About how many more people are needed; null unless `closed`. */
    needed: z.int().min(1).nullable(),
    /** The step in which `within` and `needed` are said. */
    step: z.int().min(WAITLIST_K_MIN),
  })
  .strict()
  .refine((gate) => (gate.within !== null) === (gate.state === "waiting"), {
    error: "a place in the line is said exactly when the person waits",
  })
  .refine((gate) => (gate.needed !== null) === (gate.state === "closed"), {
    error: "how many are needed is said exactly when the gate is closed",
  })
  .meta({ id: "GateResponse" });
export type GateResponse = z.infer<typeof GateResponse>;

/**
 * The gate in the export (#51, ADR-007 §4): the row as it is held. It holds
 * what the person is told and nothing finer, so the export says nothing the
 * route does not.
 */
export const ExportedGate = z
  .object({
    pondId: z.uuid(),
    admittedAt: z.iso.datetime().nullable(),
    /** The place in the line as it is said: among the next so many; null unless the person waits. */
    placeSaid: z.int().min(1).nullable(),
    /** The size of the pool as it is said, in steps. */
    poolSaid: z.int().min(0),
    openedAt: z.iso.datetime().nullable(),
    /** When a count last changed what the row says; null while the next count is to decide anew. */
    countedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "ExportedGate" });
export type ExportedGate = z.infer<typeof ExportedGate>;
