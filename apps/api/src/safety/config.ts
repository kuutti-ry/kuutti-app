import { randomUUID } from "node:crypto";
import { type Queryable, transaction } from "@kuutti/db";
import { type ConfigChange, type ConfigKey, ConfigValue } from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import { recordAudit } from "./audit.ts";

// The tunables in the panel (#304, #305): every key of matching_config with
// its versions, read by admins, and a new version with a reason, which every
// reader uses from the next request on (lib/matching-config.ts reads the
// latest row each time, with no cache). Keys are born in migrations, never
// here, and a change keeps the value's shape, so no reader gets a type it
// does not expect. Raw parameterised SQL through Queryable, as the slices'
// repositories, so the test harness's rolled-back transaction passes through.

type Row = {
  id: string;
  key: string;
  version: number;
  value: unknown;
  valid_from: Date;
  created_by: string;
  reason: string | null;
};

/** Every key, its latest value and its versions newest first, keys in order. */
export async function listConfig(db: Queryable): Promise<ConfigKey[]> {
  const { rows } = await db.query<Row>(
    `SELECT id, key, version, value, valid_from, created_by, reason
     FROM matching_config ORDER BY key, version DESC`,
  );
  const keys = new Map<string, ConfigKey>();
  for (const row of rows) {
    const version = {
      version: row.version,
      value: ConfigValue.parse(row.value),
      validFrom: row.valid_from.toISOString(),
      createdBy: row.created_by,
      reason: row.reason,
    };
    const known = keys.get(row.key);
    // The contract's thousand newest versions; a key changed more often than that keeps them in the table.
    if (known) {
      if (known.versions.length < 1000) known.versions.push(version);
    } else
      keys.set(row.key, {
        key: row.key,
        value: version.value,
        version: row.version,
        versions: [version],
      });
  }
  return [...keys.values()];
}

/** The JSON type of a value: what a reader of the key is written against. */
function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Whether a new value keeps the current one's shape: the same JSON type, and
 * for an object the same keys with values of the same type (the photo fetch
 * budgets are one). A reader parses the value it expects; a change of shape
 * is a migration's, with the code that reads it.
 */
export function sameShape(current: unknown, next: unknown): boolean {
  if (kindOf(current) !== kindOf(next)) return false;
  if (kindOf(current) !== "object") return true;
  const a = current as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const keys = Object.keys(a).sort();
  const other = Object.keys(b).sort();
  if (keys.length !== other.length || keys.some((k, i) => k !== other[i])) return false;
  return keys.every((k) => kindOf(a[k]) === kindOf(b[k]));
}

/**
 * A new version of a key (#305): the audit row first, then the row with the
 * next version number, the admin's identity as its author and the reason. Of
 * two admins changing one key at once the unique (key, version) index lets
 * one write; the other's audit row rolls back with its 409. The answer is the
 * row this call wrote, whatever another admin wrote just after it.
 */
export async function changeConfig(
  db: Queryable,
  input: { key: string; value: ConfigValue; reason: string; actor: string; at: Date },
): Promise<ConfigChange> {
  const { rows: latest } = await db.query<Row>(
    `SELECT id, key, version, value, valid_from, created_by, reason
     FROM matching_config WHERE key = $1 ORDER BY version DESC LIMIT 1`,
    [input.key],
  );
  const current = latest[0];
  if (!current) throw new AppError(404, "not_found", "No such key; keys are born in migrations");
  if (!sameShape(current.value, input.value)) {
    throw new AppError(400, "config_shape", "The value must keep the current one's type and keys", {
      key: input.key,
      expected: kindOf(current.value),
    });
  }
  const id = randomUUID();
  const version = current.version + 1;
  await transaction(db, async (tx) => {
    await recordAudit(tx, {
      actorIdentityId: input.actor,
      action: "config.change",
      subjectType: "config",
      subjectId: id,
      detail: { key: input.key, version },
    });
    const { rowCount } = await tx.query(
      `INSERT INTO matching_config (id, version, key, value, valid_from, created_by, reason)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       ON CONFLICT (key, version) DO NOTHING`,
      [id, version, input.key, JSON.stringify(input.value), input.at, input.actor, input.reason],
    );
    if (rowCount !== 1) {
      throw new AppError(409, "config_conflict", "Somebody changed this key meanwhile");
    }
  });
  return {
    key: input.key,
    version,
    value: input.value,
    validFrom: input.at.toISOString(),
    createdBy: input.actor,
    reason: input.reason,
  };
}
