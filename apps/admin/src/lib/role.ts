import type { ModeratorRole } from "@kuutti/schema";
import { createContext, useContext } from "react";

// The signed-in staff member's role, given by the shell to its screens (#308),
// for an action only some roles may take: a ban is an admin's (ADR-024 §3).
// The API's guard is what refuses; this only leaves out a button the role
// would be refused.

export const StaffRole = createContext<ModeratorRole | null>(null);

/** The role of whoever is signed in; null outside the shell. */
export const useStaffRole = () => useContext(StaffRole);
