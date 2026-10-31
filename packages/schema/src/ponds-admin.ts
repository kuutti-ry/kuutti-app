import { z } from "zod";
import { PondSummary } from "./onboarding.ts";

/**
 * The ponds in the panel (#500, ADR-060 §2): each with its switch. An admin
 * turns it; nothing else does, so the answer carries no count and no figure.
 */
export const AdminPond = PondSummary.extend({ matchingOpen: z.boolean() }).meta({
  id: "AdminPond",
});
export type AdminPond = z.infer<typeof AdminPond>;

export const AdminPondList = z
  .object({ items: z.array(AdminPond).max(200) })
  .meta({ id: "AdminPondList" });
export type AdminPondList = z.infer<typeof AdminPondList>;

export const PondIdParams = z.object({ id: z.uuid() }).meta({ id: "PondIdParams" });

export const PondMatchingChange = z
  .object({ open: z.boolean() })
  .strict()
  .meta({ id: "PondMatchingChange" });
export type PondMatchingChange = z.infer<typeof PondMatchingChange>;
