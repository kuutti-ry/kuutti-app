import type { SessionStore } from "../lib/auth-middleware.ts";
import * as repo from "./repo.ts";

/** What lib/auth-middleware.ts reads through; the queries stay in the slice. */
export const sessionStore: SessionStore = {
  findByAccessHash: repo.findSessionByAccessHash,
  touch: repo.touchSession,
  standing: (db, caller, at) => repo.sessionStanding(db, { ...caller, at }),
};
