import { it } from "vitest";
import { attackWith } from "../../../../scripts/lib/attack.ts";

/** The panel's attacks, on Vitest (#380; scripts/lib/attack.ts says what an attack is). */
export const attack = attackWith(it);
