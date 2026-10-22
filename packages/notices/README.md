# @kuutti/notices

The third-party packages a bundle is made of, with the texts their licences ask to go with every copy: the copyright lines, the licence text and any NOTICE file (#416). Two generators read them through it:

- `apps/mobile/scripts/licenses.ts` writes the app's `src/generated/licenses.json`, from the source maps of the phone bundles, for the licences screen in Settings;
- `apps/api/scripts/notices.ts` writes the API image's `dist/THIRD_PARTY_NOTICES`, from esbuild's metafile and `node_modules/@img`.

The admin panel needs neither: Vite's `build.license` writes its `licenses.txt`.

## What it does

- **`shippedPackageDirs(sources, root)`**: the package directory of each bundled file, the path up to the name after the last `node_modules`, so a nested copy is its own package.
- **`shippedFilesOf(dir)`**: the licence files (`LICENSE*`, `LICENCE*`, `COPYING*`) and NOTICE files at the top of a package, in any case, normalised.
- **`splitNotice(text)`**: a licence file that is copyright lines over a body, under at most one title line, as the lines and the body; null for any other shape, which is kept whole.
- **`collectNotices(dirs, upstream)`**: every package once by name and version, each body once however many packages share it, keyed by `textKey`, a digest of its paragraphs' words. A package with no licence file takes its rows of `upstream`: copyright lines and an address with the text of a named shipped package, or a file deeper in the package. It throws for a package with no text, for a row nothing needs and for a row whose text cannot be had.

## Tests

`pnpm --filter @kuutti/notices test`, against package directories it writes under the system's temporary directory; `test:coverage` holds every line and branch.
