import { attackWith } from "../../../../scripts/lib/attack";

/** The phone's attacks use Jest's own matcher errors and the shared helper (#380). */
export const attack = attackWith(it);
