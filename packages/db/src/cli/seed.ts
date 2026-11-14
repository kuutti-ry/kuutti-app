/**
 * Seeds ponds and matching_config version 1. Idempotent.
 *   pnpm --filter @kuutti/db seed -- --env development
 * Refuses production before opening a connection, when either --env or
 * APP_ENV names it: a flag never talks the seed past the environment it runs
 * in (#250). The environment it reports comes from --env, then APP_ENV, then
 * "development".
 */
import { createPool } from "../pool.ts";
import { assertDemoTarget, describeTarget } from "../seed/command.ts";
import { seed } from "../seed.ts";
import { argumentsOf } from "./arguments.ts";

const args = process.argv.slice(2);
const flags = args.flatMap((arg, index) =>
  arg === "--env" ? [args[index + 1]] : arg.startsWith("--env=") ? [arg.slice(6)] : [],
);
if (flags.includes("production") || process.env.APP_ENV === "production") {
  console.error("refusing to seed production: previews and local databases only (TD-19)");
  process.exit(2);
}
let flag: string | undefined;
try {
  const parsed = argumentsOf(args, ["--env"]);
  if (parsed.positionals.length) throw new Error(`unknown argument ${parsed.positionals[0]}`);
  flag = parsed.options["--env"];
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
const env = flag ?? process.env.APP_ENV ?? "development";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const pool = createPool({ connectionString: url, max: 1, applicationName: "kuutti-seed" });
try {
  // This CLI has no staging-container guard (ADR-018): only a preview may target RDS.
  assertDemoTarget(await describeTarget(pool), env === "preview" ? "preview" : "development");
  const result = await seed(pool);
  console.log(JSON.stringify({ msg: "seed", env, ...result }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
