import type { Queryable } from "@kuutti/db";
import type { QueryResultRow } from "pg";

/** An actor id no identity has: an audit row naming it is refused by the foreign key. */
const NOBODY = "00000000-0000-4000-8000-000000000000";

/**
 * A connection that records every statement it is handed, in order, so a
 * test can see that a look's audit row was written before anything it shows
 * was read (#306, #312). With `refuse`, the audit row of that action names
 * an actor no identity has, and the database refuses it as it would any
 * failed write.
 */
export function recorder(db: Queryable, refuse?: string) {
  const statements: string[] = [];
  const recorded: Queryable = {
    query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      statements.push(text);
      const fail =
        refuse !== undefined && text.includes("INTO public.audit_log") && values?.[1] === refuse;
      return db.query<R>(text, fail ? [NOBODY, ...(values ?? []).slice(1)] : values);
    },
  };
  return { db: recorded, statements };
}
