# The libvips part of the image's notices

`libvips.json` is the last part of the API image's `dist/THIRD_PARTY_NOTICES` (#416, ADR-005): libvips and every library built into the shared library of `@img/sharp-libvips-linux-arm64`, with the licence each is used under, its copyright lines and texts, and the release and patches it is built from. `scripts/notices/third-party.ts` renders it (`LibvipsPart`) and refuses a build whose installed libvips is not the one this file was gathered from.

It was gathered by hand on 22/10/2026 from sharp-libvips 1.3.4. A sharp release that moves libvips fails the build and the API's tests until it is gathered again.

## Gathering it again

1. **The release.** In sharp's `package.json`, find the `@img/sharp-libvips-*` version. In lovell/sharp-libvips at that tag, read:
   - `versions.properties`, the library versions, which must equal the package's `versions.json`;
   - `build/posix.sh`, the release tarball and patch of each library;
   - `README.md`'s licensing table, the licence each is used under. The LGPL libraries are used under LGPL-3.0, through their "or later".
2. **Each library**, at the tag of its version: the licence and copyright files its repository keeps (`COPYING`, `LICENSE*`, `PATENTS`, `NOTICE`). For an LGPL library the text is LGPL-3.0, and GPL-3.0 beside it.
   - Keep the credit statements a licence asks a binary's documentation to make as copyright lines: FreeType's "Portions of this software are copyright © <year> The FreeType Project", and libjpeg-turbo's "This software is based in part on the work of the Independent JPEG Group."
3. **librsvg's Rust crates**, the ones compiled into the library for aarch64-unknown-linux-gnu:
   - Start from librsvg's `Cargo.lock` at its tag, with the Cargo features sharp-libvips builds it with. Leave out proc-macro and build-only crates.
   - Each crate's `.crate` from static.crates.io gives its licence files.
   - A crate under "A OR B" is used under MIT where MIT is among them.
   - The crates Rust's standard library is built with are in the object code too: `strings -a lib/libvips-cpp.so.* | grep /cargo/registry/` names them.
4. **Write the file** in the shape `LibvipsPart` describes:
   - Each text goes under the key `textKey` from `@kuutti/notices` gives it, split with `splitNotice`.
   - Each library names its source and the address of every text.
   - Copy `versions.json` as it is.
   - `pnpm --filter @kuutti/api test -- scripts/notices` then holds the file to the install, and `pnpm --filter @kuutti/api build` writes the notices.
