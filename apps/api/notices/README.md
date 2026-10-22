# The libvips part of the image's notices

`libvips.json` is the last part of the API image's `dist/THIRD_PARTY_NOTICES` (#416, ADR-005): libvips and every library built into the shared library of `@img/sharp-libvips-linux-arm64`, with the licence each is used under, its copyright lines and texts, and the release and patches it is built from. `scripts/notices/third-party.ts` renders it (`LibvipsPart`) and refuses a build whose installed libvips is not the one this file was gathered from.

It was gathered by hand on 22/10/2026 from sharp-libvips 1.3.4; since #421 a command gathers it, and reproduces that file byte for byte. A sharp release that moves libvips fails the build and the API's tests until it is gathered again.

## Gathering it again

After the bump is installed:

```
pnpm --filter @kuutti/api notices:libvips
```

It gathers for the sharp-libvips the install holds (`-- --version <x>` for another) and writes `libvips.json`; the diff is what to review: new versions, new or dropped libraries and crates, changed copyright lines and texts. Then `pnpm --filter @kuutti/api test -- scripts/notices` holds the file to the install, and `pnpm --filter @kuutti/api build` writes the notices.

It reads over HTTPS (and tags with `git ls-remote`), never running anything it fetched, and keeps every download under `~/.cache/kuutti-libvips-notices`, so a second run is quick; delete that directory to fetch afresh. What it does, in `scripts/notices/libvips.ts`:

1. **The release.** lovell/sharp-libvips at the tag `v<version>`:
   - `versions.properties`, the library versions, which must equal the npm package's `versions.json`, copied into the file as it is;
   - `build/posix.sh`, read for linux-arm64v8 (its conditions evaluated with `platforms/linux-arm64v8/Dockerfile`'s environment): the release tarball and patches of each library, and its `sed` edits of librsvg's Cargo manifests;
   - `THIRD-PARTY-NOTICES.md`'s table, the licence each is used under. The LGPL libraries are used under LGPL-3.0, through their "or later".
2. **Each library**, by its row of `LIBRARIES`: the licence it is used under, its repository, its tag, and the licence and copyright files to read at the commit that tag names (`COPYING`, `LICENSE*`, `PATENTS`, `NOTICE`). For an LGPL library the text is LGPL-3.0, and GPL-3.0 beside it.
   - The credit statements a licence asks a binary's documentation to make are kept as copyright lines: FreeType's "Portions of this software are copyright © <year> The FreeType Project", the year that of its README, and libjpeg-turbo's "This software is based in part on the work of the Independent JPEG Group."
3. **librsvg's Rust crates**, the ones compiled into the library for aarch64-unknown-linux-gnu:
   - From librsvg's `Cargo.lock` and manifests at its tag, with sharp-libvips' edits, resolved as Cargo's feature resolver would for `librsvg-c`; proc-macro and build-only crates are left out, and a patch of sharp-libvips' that changes a Cargo file fails the command.
   - Each crate's `.crate` from static.crates.io, held to the lock's checksum, gives its licence files. A crate under "A OR B" is used under MIT where MIT is among them, else BSD-3-Clause; a file of the alternative not used is left out, and so is one that only names the licences. A licence whose text the crate does not carry takes the text most crates under it carry.
   - The crates Rust's standard library is built with are in the object code too: the `/cargo/registry/` paths of the npm package's `lib/libvips-cpp.so.*` name them, as `strings -a … | grep /cargo/registry/` would; one librsvg is built with too is listed once, as librsvg's.
4. **node-addon-api**, which sharp's addon is compiled with, at the floor of the installed sharp's range.

Each text goes under the key `textKey` from `@kuutti/notices` gives it, split with `splitNotice` (libpng's licence whole: its title would pass for a copyright line).

## When it fails

- **A library the build gains, or a row it no longer needs.** Add or remove its row in `LIBRARIES` (`scripts/notices/libvips.ts`), read from the library's own repository at its tag: what it is used under (sharp-libvips' table names it), its repository and tag, its licence files.
- **A crate under alternatives without MIT or BSD-3-Clause**, or a licence no crate carries the text of: choose in `usedLicences`, or add the licence to `READS`.
- **A line of `build/posix.sh` it cannot read** (a condition, a variable, a Cargo edit by pattern): the build changed shape; read what it does and teach the reader, rather than guessing.
