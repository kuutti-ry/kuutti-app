/**
 * Seeds ponds and matching_config version 1. Idempotent.
 *   pnpm --filter @kuutti/db seed -- --env development
 * Refuses production before opening a connection, when either --env or
 * APP_ENV names it: a flag never talks the seed past the environment it runs
 * in (#250). The environment it reports comes from --env, then APP_ENV, then
 * "development".
 */
import { createPool } from "../pool.ts";
import { seed } from "../seed.ts";

const args = process.argv.slice(2);
const flagIndex = args.indexOf("--env");
const flag = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
const env = flag ?? process.env.APP_ENV ?? "development";

if (flag === "production" || process.env.APP_ENV === "production") {
  console.error("refusing to seed production: previews and local databases only (TD-19)");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const pool = createPool({ connectionString: url, max: 1, applicationName: "kuutti-seed" });
try {
  const result = await seed(pool);
  console.log(JSON.stringify({ msg: "seed", env, ...result }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
