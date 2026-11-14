import { it } from "vitest";
import { attackWith } from "../../../../scripts/lib/attack.ts";

/** Contract attacks on the shared boundary, using the same inversion as the apps (#380). */
export const attack = attackWith(it);
