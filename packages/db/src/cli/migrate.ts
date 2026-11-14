/**
 * Applies committed migrations under the advisory lock.
 *   pnpm --filter @kuutti/db migrate
 * Exit codes: 0 applied or nothing to do, 1 failed. DATABASE_URL from the
 * environment (node --env-file-if-exists reads the root .env in development).
 */
import { resolve } from "node:path";
import { migrate } from "../migrate.ts";
import { createPool } from "../pool.ts";
import { argumentsOf } from "./arguments.ts";

try {
  const { positionals } = argumentsOf(process.argv.slice(2), []);
  if (positionals.length) throw new Error(`unknown argument ${positionals[0]}`);
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const folder = resolve(import.meta.dirname, "..", "..", "drizzle");
const pool = createPool({ connectionString: url, max: 1, applicationName: "kuutti-migrate" });
try {
  const result = await migrate(pool, folder);
  console.log(JSON.stringify({ msg: "migrate", ...result }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
