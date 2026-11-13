import type { Queryable } from "@kuutti/db";
import { testPool } from "./harness.ts";

/**
 * One transaction of the test database, rolled back whatever the work did
 * (#380): the harness's own road (`harness.ts`'s `test`) for an attack, which
 * registers its tests itself and so cannot take that fixture.
 */
export async function rolledBack<T>(work: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await testPool().connect();
  await client.query("BEGIN");
  try {
    return await work(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}
