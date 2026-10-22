/**
 * Writes the API image's THIRD_PARTY_NOTICES (#416) from what tsup just
 * bundled and the packages of node_modules/@img (notices/third-party.ts).
 *
 *   pnpm --filter @kuutti/api build
 *
 * runs tsup and then this, which writes dist/THIRD_PARTY_NOTICES and removes
 * the metafile, so the image's dist holds the notices and not a list of the
 * build's paths. A package with no text fails the build, in the Dockerfile
 * too, so a dependency cannot reach the image without its notice.
 */
import { writeNotices } from "./notices/third-party.ts";

const { packages, libraries } = writeNotices();
console.log(
  `✔ notices: ${packages} packages and ${libraries} libraries of libvips and sharp's addon; written to dist/THIRD_PARTY_NOTICES`,
);
