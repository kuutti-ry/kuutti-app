import { sql } from "drizzle-orm";
import { check, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { account } from "./identity.ts";
import { ponds } from "./ponds.ts";

/**
 * A person's place at the pond gate (#94, ADR-015; TD-10): whether they were
 * let into the pond or wait, and whether matching has opened for them.
 * Written by the count (`jobs/pond-gate.ts`), read by the person's own route.
 *
 * The row holds what the person is told and nothing finer. `pool_said` is
 * the size of their pool in steps, and `place_said` their place in the line
 * in steps ("among the next ten"); the exact figures exist while a count
 * runs and are kept nowhere (ADR-015 §6), so neither the route nor the
 * export has anything to give away about one other person.
 *
 * `admitted_at` and `opened_at` are set once by the count: nobody is let out
 * when the pond drifts and no gate closes again (TD-13). What takes them
 * back is the person's own doing: another pond, or a change of gender or of
 * whom they seek that brings them into a group that waits (ADR-015 §8, §9).
 * The row is then emptied, `counted_at` with it, and the next count decides.
 * `counted_at` is when a count last wrote the row: a count that finds
 * nothing to change writes nothing.
 *
 * The row goes with the account at erasure (TD-7).
 */
export const gate = pgTable(
  "gate",
  {
    accountId: uuid("account_id")
      .primaryKey()
      .references(() => account.id),
    pondId: uuid("pond_id")
      .notNull()
      .references(() => ponds.id),
    admittedAt: timestamp("admitted_at", { withTimezone: true }),
    placeSaid: integer("place_said"),
    poolSaid: integer("pool_said").notNull().default(0),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    countedAt: timestamp("counted_at", { withTimezone: true }),
  },
  (table) => [
    check("gate_place_said_check", sql`${table.placeSaid} IS NULL OR ${table.placeSaid} >= 1`),
    check("gate_pool_said_check", sql`${table.poolSaid} >= 0`),
    // Somebody who is let in has no place in the line, and a gate opens only for somebody let in.
    check("gate_admitted_check", sql`${table.admittedAt} IS NULL OR ${table.placeSaid} IS NULL`),
    check("gate_opened_check", sql`${table.openedAt} IS NULL OR ${table.admittedAt} IS NOT NULL`),
  ],
);
