import type { Queryable } from "@kuutti/db";
import type { DistanceEdges } from "@kuutti/schema";
import type { z } from "zod";
import { AppError } from "./errors.ts";

/**
 * Every tunable is a row in matching_config, never a constant in code
 * (CLAUDE.md Product constraints). The latest version of a key wins. A key
 * that is missing is a deployment without its seed, which is an error to
 * surface, not a default to fall back on.
 */
export async function readMatchingConfig(db: Queryable, key: string): Promise<unknown> {
  const { rows } = await db.query<{ value: unknown }>(
    "SELECT value FROM matching_config WHERE key = $1 ORDER BY version DESC LIMIT 1",
    [key],
  );
  if (rows.length === 0) throw noRow(key);
  return rows[0]?.value;
}

/** A missing key: a deployment without its seed. */
function noRow(key: string): AppError {
  return new AppError(500, "internal_error", `matching_config has no row for ${key}`, { key });
}

/** A value of another shape than its reader's, `shape` in words: a broken deployment. */
function notA(key: string, shape: string): AppError {
  return new AppError(500, "internal_error", `matching_config ${key} is not ${shape}`, { key });
}

/** A value read as a number: finite, or `notA` a number. */
function asNumber(key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw notA(key, "a number");
  return value;
}

export async function matchingConfigNumber(db: Queryable, key: string): Promise<number> {
  return asNumber(key, await readMatchingConfig(db, key));
}

/**
 * A value read as its contract's schema reads it; one of another shape is a
 * broken deployment, answered 500 with the key named, its `shape` in words.
 */
export async function matchingConfigOf<T>(
  db: Queryable,
  key: string,
  schema: z.ZodType<T>,
  shape: string,
): Promise<T> {
  const parsed = schema.safeParse(await readMatchingConfig(db, key));
  if (!parsed.success) throw notA(key, shape);
  return parsed.data;
}

/**
 * Several numbers in one statement, the latest version of each key; a missing
 * or non-numeric key fails as matchingConfigNumber does.
 */
export async function matchingConfigNumbers<K extends string>(
  db: Queryable,
  keys: readonly K[],
): Promise<Record<K, number>> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    "SELECT DISTINCT ON (key) key, value FROM matching_config WHERE key = ANY($1) ORDER BY key, version DESC",
    [keys],
  );
  const latest = new Map(rows.map((row) => [row.key, row.value]));
  const out = {} as Record<K, number>;
  for (const key of keys) {
    if (!latest.has(key)) throw noRow(key);
    out[key] = asNumber(key, latest.get(key));
  }
  return out;
}

/** Each band's outer edge (ADR-061 §5), read once where a pool is read. */
export async function distanceEdges(db: Queryable): Promise<DistanceEdges> {
  const km = await matchingConfigNumbers(db, [
    "distance_nearby_km",
    "distance_close_km",
    "distance_around_km",
  ]);
  return {
    nearby: km.distance_nearby_km,
    close: km.distance_close_km,
    around: km.distance_around_km,
  };
}

/**
 * An hour of the day, 0 to 23, read as matchingConfigNumber reads a number: the
 * push's quiet hours (#102, ADR-055 §7). The panel keeps a number whole and from
 * 0 but has no ceiling, and a 24 is no hour there is, so anything else fails as
 * a missing row.
 */
export function asHour(key: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 23) {
    throw notA(key, "an hour");
  }
  return value;
}
