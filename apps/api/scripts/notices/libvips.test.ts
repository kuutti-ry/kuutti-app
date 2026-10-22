import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { textKey } from "@kuutti/notices";
import { describe, expect, it } from "vitest";
import {
  applyEdits,
  builtLibraries,
  type Crate,
  condition,
  dockerEnv,
  gatherLibvips,
  LIBRARIES,
  type Locked,
  lsRemoteCommit,
  parseLock,
  parseManifest,
  parseProperties,
  type Row,
  resolveCrates,
  rustOf,
  type Source,
  targetHolds,
  untar,
  usedLicences,
  usedUnder,
} from "./libvips.ts";

// The gathering of notices/libvips.json (#421) on fixtures: nothing here
// reaches the network. Each reader on its inputs, then whole releases served
// from a table, the real LIBRARIES' rows among them.

const MIT =
  "Permission is hereby granted, free of charge, to any person obtaining a copy of this software\nand associated documentation files.\n\nTHE SOFTWARE IS PROVIDED AS IS.";
const MIT_WRAPPED =
  "Permission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files.\n\nTHE SOFTWARE IS PROVIDED AS IS.";
/** MIT in other words, and BSD-3-Clause: a licence's texts that are not the same text. */
const MIT_OTHER =
  "Permission is hereby granted, free of charge, to any person obtaining a copy of this software (including the next paragraph).";
const BSD3_OTHER =
  "Redistribution and use in source and binary forms are permitted.\n\nNeither the name of WHATWG nor its contributors.";
const APACHE = "Apache License\nVersion 2.0, January 2004\n\nTERMS AND CONDITIONS";
const BSD3 =
  "Redistribution and use in source and binary forms, with or without modification.\n\nNeither the name of the copyright holder nor its contributors.";
const MPL =
  "Mozilla Public License Version 2.0\n==================================\n\n1. Definitions";
const UNICODE =
  "UNICODE LICENSE V3\n\nCOPYRIGHT AND PERMISSION NOTICE\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of data files.";
const LGPL = "GNU LESSER GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007";
const GPL = "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007";

/** A tar entry's 512-byte header. */
function header(name: string, size: number, type: string, prefix = ""): Uint8Array {
  const block = new Uint8Array(512);
  const put = (at: number, text: string) => block.set(new TextEncoder().encode(text), at);
  put(0, name);
  put(100, "0000644\0");
  put(124, `${size.toString(8).padStart(11, "0")}\0`);
  put(156, type);
  put(257, "ustar\0");
  put(345, prefix);
  return block;
}

type Entry = { name: string; body: string | Uint8Array; type?: string; prefix?: string };

/** A tar archive of `entries`, ending in two zero blocks. */
function tar(entries: Entry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const { name, body, type = "0", prefix } of entries) {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    parts.push(header(name, bytes.length, type, prefix), bytes);
    parts.push(new Uint8Array((512 - (bytes.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  return Buffer.concat(parts);
}

const files = (record: Record<string, string>): Entry[] =>
  Object.entries(record).map(([name, body]) => ({ name, body }));

/** A .crate: the gzipped tar of `<name>-<version>/` with a Cargo.toml and `others`. */
function crate(name: string, version: string, toml: string, others: Record<string, string> = {}) {
  const dir = `${name}-${version}`;
  return gzipSync(
    tar(
      files({
        [`${dir}/Cargo.toml`]: `[package]\nname = "${name}"\nversion = "${version}"\n${toml}`,
        ...Object.fromEntries(Object.entries(others).map(([f, t]) => [`${dir}/${f}`, t])),
      }),
    ),
  );
}

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A Source over a table of addresses; a commit is the digest of its repository and ref. */
function served(
  table: Map<string, string | Uint8Array>,
  fallback?: (url: string) => string | undefined,
): Source {
  const get = (url: string) => {
    const found = table.get(url) ?? fallback?.(url);
    if (found === undefined) throw new Error(`not in the fixture: ${url}`);
    return found;
  };
  return {
    text: async (url) => {
      const found = get(url);
      return typeof found === "string" ? found : new TextDecoder().decode(found);
    },
    bytes: async (url) => {
      const found = get(url);
      return typeof found === "string" ? new TextEncoder().encode(found) : found;
    },
    commit: async (repository, ref) => sha1(`${repository}@${ref}`),
  };
}

describe("sharp-libvips' release", () => {
  it("names each library's version as versions.json does", () => {
    expect(
      parseProperties(
        "VERSION_AOM=3.15.1\nVERSION_ZLIB_NG=2.3.3 \nVERSION_PROXY_LIBINTL=0.5\n# a comment\nOTHER=1\nVERSION_BROKEN\n",
      ),
    ).toEqual({ aom: "3.15.1", "zlib-ng": "2.3.3", "proxy-libintl": "0.5" });
  });

  it("reads the environment of a platform's Dockerfile, continued lines too", () => {
    const dockerfile =
      'FROM x\nENV \\\n  PLATFORM="linux-arm64v8" \\\n  FLAGS="-march=armv8-a"\nRUN echo ENV A="b"\nENV RUSTFLAGS="-Z x"\n';
    expect(dockerEnv(dockerfile)).toEqual({
      PLATFORM: "linux-arm64v8",
      FLAGS: "-march=armv8-a",
      RUSTFLAGS: "-Z x",
    });
  });

  it("reads THIRD-PARTY-NOTICES.md's table without its links", () => {
    const table = usedUnder(
      [
        "# Third-party notices",
        "| Library | Used under the terms of |",
        "|---------|-------------------------|",
        "| aom     | BSD 2-Clause + [Alliance for Open Media Patent License 1.0](https://aomedia.org/license/patent-license/) |",
        "| glib    | LGPLv3 |",
        "| broken  |",
        "",
      ].join("\n"),
    );
    expect([...table]).toEqual([
      ["aom", "BSD 2-Clause + Alliance for Open Media Patent License 1.0"],
      ["glib", "LGPLv3"],
    ]);
  });
});

describe("build/posix.sh, read", () => {
  const versions = {
    glib: "2.90.0",
    vips: "8.18.7-rc1",
    freetype: "2.14.3",
    expat: "2.8.5",
    rsvg: "2.63.2",
    "proxy-libintl": "0.5",
    highway: "1.4.0",
  };
  const env = { PLATFORM: "linux-arm64v8", LINUX: "true" };
  const script = [
    "#!/usr/bin/env bash",
    "without_patch() {",
    `  echo "\${1%.[[:digit:]]*}"`,
    "}",
    "build_freetype() {",
    `  rm -rf \${DEPS}/freetype`,
    `  mkdir \${DEPS}/freetype`,
    `  $CURL https://github.com/freetype/freetype/archive/VER-\${VERSION_FREETYPE//./-}.tar.gz | tar xzC \${DEPS}/freetype --strip-components=1`,
    "}",
    "function copydeps {",
    '  if [ ! -f "$dest" ]; then',
    "    echo nothing of a library here",
    "  fi",
    "}",
    'if [ "$(uname)" == "Darwin" ]; then',
    "  echo a condition this cannot read, around no library",
    "fi",
    `if [ "\${PLATFORM%-*}" == "linuxmusl" ] || [ "$DARWIN" = true ]; then`,
    `  mkdir \${DEPS}/proxy-libintl`,
    `  $CURL https://github.com/frida/proxy-libintl/archive/\${VERSION_PROXY_LIBINTL}.tar.gz | tar xzC \${DEPS}/proxy-libintl`,
    "fi",
    `mkdir \${DEPS}/glib`,
    `$CURL https://download.gnome.org/sources/glib/$(without_patch $VERSION_GLIB)/glib-\${VERSION_GLIB}.tar.xz | tar xJC \${DEPS}/glib --strip-components=1`,
    "$CURL https://gist.example/glib-without-gregex.patch | patch -p1",
    "$CURL https://gist.example/glib-without-gregex.patch | patch -p1",
    'if [ -z "$WITHOUT_HIGHWAY" ]; then',
    `  mkdir \${DEPS}/highway`,
    `  $CURL https://github.com/google/highway/archive/$VERSION_HIGHWAY.tar.gz | tar xzC \${DEPS}/highway`,
    "fi",
    "build_freetype -Dharfbuzz=disabled",
    `mkdir \${DEPS}/expat`,
    `$CURL https://github.com/libexpat/libexpat/releases/download/R_\${VERSION_EXPAT//./_}/expat-\${VERSION_EXPAT}.tar.xz | tar xJC \${DEPS}/expat`,
    "build_freetype -Dharfbuzz=enabled",
    `mkdir \${DEPS}/rsvg`,
    `$CURL https://download.gnome.org/sources/librsvg/$(without_patch $VERSION_RSVG)/librsvg-\${VERSION_RSVG}.tar.xz | tar xJC \${DEPS}/rsvg`,
    `sed -i'.bak' "/image = /s/, \\"gif\\", \\"webp\\"//" rsvg/Cargo.toml`,
    `sed -i'.bak' "/cairo-rs = /s/, \\"pdf\\", \\"ps\\"//" {librsvg-c,rsvg}/Cargo.toml`,
    `sed -i'.bak' "/^if host_system in \\['windows'/s/, 'linux'//" meson.build`,
    "$CURL https://github.com/GNOME/librsvg/commit/9106011.patch | patch -p1",
    'if [ "$LINUX" = true ]; then',
    `  mkdir \${DEPS}/vips`,
    'elif [ "$DARWIN" = true ]; then',
    `  mkdir \${DEPS}/never`,
    "else",
    `  mkdir \${DEPS}/never`,
    "fi",
    `$CURL https://github.com/libvips/libvips/releases/download/v\${VERSION_VIPS}/vips-$(without_prerelease $VERSION_VIPS).tar.xz | tar xJC \${DEPS}/vips`,
    "$CURL -O https://raw.githubusercontent.com/lovell/sharp-libvips/main/THIRD-PARTY-NOTICES.md",
    `copydeps \${VIPS_CPP_DEP} \${TARGET}/lib-filtered`,
  ].join("\n");

  it("names what the platform builds, from which release, with which patches and Cargo edits, in its order", () => {
    expect(builtLibraries(script, versions, env)).toEqual([
      {
        dir: "glib",
        key: "glib",
        tarball: "https://download.gnome.org/sources/glib/2.90/glib-2.90.0.tar.xz",
        patches: ["https://gist.example/glib-without-gregex.patch"],
        edits: [],
      },
      {
        dir: "highway",
        key: "highway",
        tarball: "https://github.com/google/highway/archive/1.4.0.tar.gz",
        patches: [],
        edits: [],
      },
      {
        dir: "freetype",
        key: "freetype",
        tarball: "https://github.com/freetype/freetype/archive/VER-2-14-3.tar.gz",
        patches: [],
        edits: [],
      },
      {
        dir: "expat",
        key: "expat",
        tarball:
          "https://github.com/libexpat/libexpat/releases/download/R_2_8_5/expat-2.8.5.tar.xz",
        patches: [],
        edits: [],
      },
      {
        dir: "rsvg",
        key: "rsvg",
        tarball: "https://download.gnome.org/sources/librsvg/2.63/librsvg-2.63.2.tar.xz",
        patches: ["https://github.com/GNOME/librsvg/commit/9106011.patch"],
        edits: [
          { address: "image = ", from: ', "gif", "webp"', to: "", files: ["rsvg/Cargo.toml"] },
          {
            address: "cairo-rs = ",
            from: ', "pdf", "ps"',
            to: "",
            files: ["librsvg-c/Cargo.toml", "rsvg/Cargo.toml"],
          },
        ],
      },
      {
        dir: "vips",
        key: "vips",
        tarball:
          "https://github.com/libvips/libvips/releases/download/v8.18.7-rc1/vips-8.18.7.tar.xz",
        patches: [],
        edits: [],
      },
    ]);
  });

  it("leaves out what another platform builds", () => {
    const darwin = builtLibraries(
      script,
      { ...versions, vips: "8.18.7" },
      { PLATFORM: "darwin-arm64v8", DARWIN: "true" },
    );
    expect(darwin.map((b) => b.dir)).toEqual([
      "proxy-libintl",
      "glib",
      "highway",
      "freetype",
      "expat",
      "rsvg",
      "never",
    ]);
    expect(darwin.at(-1)?.tarball).toBe(
      "https://github.com/libvips/libvips/releases/download/v8.18.7/vips-8.18.7.tar.xz",
    );
    const without = builtLibraries(script, versions, { ...env, WITHOUT_HIGHWAY: "true" });
    expect(without.map((b) => b.dir)).not.toContain("highway");
  });

  it.each([
    [
      "a library under a condition it cannot evaluate",
      `if [ "$(uname)" == "Linux" ]; then\nmkdir \${DEPS}/glib\nfi`,
      `a condition this cannot evaluate holds "mkdir \${DEPS}/glib"`,
    ],
    [
      "a library in the else of a condition it cannot evaluate",
      `if [ "$(uname)" == "Linux" ]; then\necho\nelse\nmkdir \${DEPS}/glib\nfi`,
      "a condition this cannot evaluate",
    ],
    [
      "a library under an elif it cannot evaluate",
      `if [ "$DARWIN" = true ]; then\necho\nelif [ "$(uname)" == "x" ]; then\nmkdir \${DEPS}/glib\nfi`,
      "a condition this cannot evaluate",
    ],
    [
      "a fetch before any library",
      `$CURL https://x.example/glib-\${VERSION_GLIB}.tar.gz | tar xz`,
      "comes before any library",
    ],
    [
      "a library from two releases",
      `mkdir \${DEPS}/glib\n$CURL https://x.example/a-$VERSION_GLIB.tar.gz | tar xz\n$CURL https://x.example/b-$VERSION_GLIB.tar.gz | tar xz`,
      "fetches glib from two releases",
    ],
    [
      "a release that names two versions",
      `mkdir \${DEPS}/glib\n$CURL https://x.example/$VERSION_GLIB-$VERSION_RSVG.tar.gz | tar xz`,
      "names 2 versions, not one",
    ],
    [
      "a release that names no version",
      `mkdir \${DEPS}/glib\n$CURL https://x.example/glib.tar.gz | tar xz`,
      "names 0 versions, not one",
    ],
    [
      "a library with no release",
      `mkdir \${DEPS}/glib\nmkdir \${DEPS}/rsvg\n$CURL https://x.example/$VERSION_RSVG.tar.gz | tar xz`,
      "fetches no release of glib",
    ],
    [
      "a version versions.properties lacks",
      `mkdir \${DEPS}/glib\n$CURL https://x.example/$VERSION_NONE.tar.gz | tar xz`,
      "names VERSION_NONE, which versions.properties does not",
    ],
    [
      "a variable it cannot expand",
      `mkdir \${DEPS}/glib\n$CURL https://x.example/\${VERSION_GLIB%.*}.tar.gz | tar xz`,
      "uses a variable this cannot expand",
    ],
    [
      "a Cargo edit it cannot apply",
      `mkdir \${DEPS}/rsvg\n$CURL https://x.example/$VERSION_RSVG.tar.gz | tar xz\nsed -i'.bak' "s/a.b/c/" rsvg/Cargo.toml`,
      'edits rsvg/Cargo.toml with "s/a.b/c/"',
    ],
    [
      "a Cargo edit by a pattern",
      `mkdir \${DEPS}/rsvg\n$CURL https://x.example/$VERSION_RSVG.tar.gz | tar xz\nsed -i'.bak' "/a.*/s/b/c/" Cargo.lock`,
      "which this cannot apply",
    ],
  ])("fails on %s", (_, text, message) => {
    expect(() => builtLibraries(text, versions, env)).toThrow(message);
  });
});

describe("a test of build/posix.sh", () => {
  const env = { PLATFORM: "linux-arm64v8", LINUX: "true", EMPTY: "" };
  it.each([
    ['[ "$LINUX" = true ]', true],
    ['[ "$DARWIN" = true ]', false],
    [`[ "\${LINUX}" == "true" ]`, true],
    [`[ "\${PLATFORM%-*}" == "linux" ]`, true],
    [`[ "\${LINUX%-*}" == "true" ]`, true],
    [`[ "\${PLATFORM%-*}" == "linuxmusl" ] || [ "$DARWIN" = true ]`, false],
    ['[ "$DARWIN" = true ] || [ "$LINUX" = true ]', true],
    ['[ "$LINUX" = true ] && [ -z "$WITHOUT_NEON" ]', true],
    ['[ "$LINUX" = true ] && [ -n "$EMPTY" ]', false],
    ['[ -n "$PLATFORM" ]', true],
    ['[ -z "$(uname)" ]', null],
    ['[ "$(uname)" == "Darwin" ]', null],
    ['[ "$(uname)" == "Darwin" ] || [ "$LINUX" = true ]', true],
    ['[ "$(uname)" == "Darwin" ] || [ "$DARWIN" = true ]', null],
    ['[ ! -f "$x" ]', null],
    ["test -f x", null],
  ])("%s is %s", (text, holds) => {
    expect(condition(text, env)).toBe(holds);
  });

  it("is edited as sed edits it: the first match on each line holding the address", () => {
    const edits = [{ address: "image = ", from: ', "gif"', to: "", files: ["rsvg/Cargo.toml"] }];
    const toml = 'image = { features = ["png", "gif", "gif"] }\nother = ["png", "gif"]';
    expect(applyEdits("rsvg/Cargo.toml", toml, edits)).toBe(
      'image = { features = ["png", "gif"] }\nother = ["png", "gif"]',
    );
    expect(applyEdits("Cargo.toml", toml, edits)).toBe(toml);
  });
});

describe("an archive", () => {
  it("is its regular files by path, long names in any of tar's three ways", () => {
    const long = `${"l".repeat(60)}/${"n".repeat(60)}`;
    const big = "x".repeat(700);
    const archive = tar([
      { name: "pkg/", body: "", type: "5" },
      { name: "pkg/a.txt", body: "a" },
      { name: "pkg/big", body: big },
      { name: "f".repeat(60), body: "prefixed", prefix: "pkg/".concat("d".repeat(60)) },
      { name: "././@LongLink", body: `pkg/${long}\0`, type: "L" },
      { name: "pkg/cut", body: "gnu" },
      { name: "pax", body: "30 mtime=1\n28 path=pkg/from-pax.txt\n", type: "x" },
      { name: "pkg/cut2", body: "pax" },
      { name: "pax", body: "12 comment=x\n", type: "x" },
      { name: "pkg/b.txt", body: "b" },
      { name: "pkg/old", body: "v7", type: "\0" },
      { name: "global", body: "52 comment=4b3f0b06f39fb5529cead381694f8929901bc273\n", type: "g" },
      { name: "pkg/link", body: "", type: "2" },
    ]);
    const read = untar(archive);
    const text = (path: string) => new TextDecoder().decode(read.get(path));
    expect([...read.keys()]).toEqual([
      "pkg/a.txt",
      "pkg/big",
      `pkg/${"d".repeat(60)}/${"f".repeat(60)}`,
      `pkg/${long}`,
      "pkg/from-pax.txt",
      "pkg/b.txt",
      "pkg/old",
    ]);
    expect(text("pkg/big")).toBe(big);
    expect(text(`pkg/${long}`)).toBe("gnu");
    expect(text("pkg/from-pax.txt")).toBe("pax");
    expect(untar(new Uint8Array(100)).size).toBe(0);
  });
});

describe("Cargo's files", () => {
  it("are the lock's entries, a dependency's version where the lock names two", () => {
    const lock = parseLock(
      [
        "version = 4",
        "[[package]]",
        'name = "librsvg-c"',
        'version = "2.63.2"',
        'dependencies = ["cairo-rs", "phf_shared 0.13.1"]',
        "[[package]]",
        'name = "cairo-rs"',
        'version = "0.22.9"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        'checksum = "abc"',
      ].join("\n"),
    );
    expect(lock).toEqual([
      {
        name: "librsvg-c",
        version: "2.63.2",
        dependencies: [{ name: "cairo-rs" }, { name: "phf_shared", version: "0.13.1" }],
      },
      {
        name: "cairo-rs",
        version: "0.22.9",
        source: "registry+https://github.com/rust-lang/crates.io-index",
        checksum: "abc",
        dependencies: [],
      },
    ]);
    expect(parseLock("version = 4")).toEqual([]);
  });

  it("are a manifest's normal dependencies and features, a member's taken from its workspace", () => {
    const workspace = {
      workspace: {
        package: { version: "2.63.2", license: "LGPL-2.1-or-later" },
        dependencies: {
          image: { version: "0.25.0", "default-features": false, features: ["jpeg"] },
          cast: "0.3.0",
          librsvg: { path: "rsvg" },
        },
      },
    };
    const member = parseManifest(
      [
        "[package]",
        'name = "librsvg-c"',
        "version.workspace = true",
        "license.workspace = true",
        "[dependencies]",
        'image = { workspace = true, features = ["png"], optional = true }',
        "cast.workspace = true",
        'librsvg = { workspace = true, features = ["capi"] }',
        "missing.workspace = true",
        "[build-dependencies]",
        'regex = "1"',
        "[dev-dependencies]",
        'tempfile = "3"',
        "[target.'cfg(unix)'.dependencies]",
        'libc = "0.2"',
        "[features]",
        'pixbuf = ["dep:gdk-pixbuf"]',
      ].join("\n"),
      workspace,
    );
    expect(member).toEqual({
      name: "librsvg-c",
      version: "2.63.2",
      license: "LGPL-2.1-or-later",
      procMacro: false,
      dependencies: [
        {
          key: "image",
          name: "image",
          req: "0.25.0",
          optional: true,
          defaultFeatures: false,
          features: ["jpeg", "png"],
        },
        {
          key: "cast",
          name: "cast",
          req: "0.3.0",
          optional: false,
          defaultFeatures: true,
          features: [],
        },
        {
          key: "librsvg",
          name: "librsvg",
          req: "*",
          optional: false,
          defaultFeatures: true,
          features: ["capi"],
        },
        {
          key: "missing",
          name: "missing",
          req: "*",
          optional: false,
          defaultFeatures: true,
          features: [],
        },
        {
          key: "libc",
          name: "libc",
          req: "0.2",
          optional: false,
          defaultFeatures: true,
          features: [],
          target: "cfg(unix)",
        },
      ],
      features: { pixbuf: ["dep:gdk-pixbuf"] },
    });
    const published = parseManifest(
      '[package]\nname = "derive_more-impl"\nversion = "2.1.1"\n[lib]\nproc-macro = true\n[dependencies.syn]\nversion = "2"\npackage = "syn2"\n[target.x86_64-pc-windows-msvc.dependencies.windows-sys]\nversion = "0.59"',
    );
    expect(published).toMatchObject({
      procMacro: true,
      dependencies: [
        { key: "syn", name: "syn2", req: "2" },
        { key: "windows-sys", target: "x86_64-pc-windows-msvc" },
      ],
      features: {},
    });
    expect(published.license).toBeUndefined();
    expect(
      parseManifest('[package]\nname = "x"\nversion = "1.0.0"\n[lib]\nname = "x"').procMacro,
    ).toBe(false);
  });

  it.each([
    ["aarch64-unknown-linux-gnu", true],
    ["x86_64-pc-windows-msvc", false],
    ["cfg(unix)", true],
    ["cfg(windows)", false],
    ['cfg(target_os = "linux")', true],
    ['cfg(target_os = "macos")', false],
    ['cfg(all(not(target_os = "macos"), not(target_os = "windows")))', true],
    ['cfg(any(target_os = "macos", target_os = "windows"))', false],
    ['cfg(any(target_arch = "x86", target_arch = "aarch64",))', true],
    ['cfg(all(target_arch = "aarch64", target_feature = "neon"))', true],
    ['cfg(target_has_atomic = "64")', true],
    ["cfg(docsrs)", false],
  ])("a target table %s is the platform's: %s", (target, holds) => {
    expect(targetHolds(target)).toBe(holds);
  });

  it("refuses a target table it cannot read", () => {
    expect(() => targetHolds("cfg(all unix)")).toThrow("a cfg this cannot read: cfg(all unix)");
  });
});

describe("the crates of a build", () => {
  const registry = "registry+https://github.com/rust-lang/crates.io-index";
  const lock: Locked[] = [
    {
      name: "app",
      version: "1.0.0",
      dependencies: [
        { name: "a" },
        { name: "b" },
        { name: "c" },
        { name: "d" },
        { name: "e" },
        { name: "macros" },
        { name: "k", version: "1.2.0" },
        { name: "k", version: "2.0.1" },
        { name: "weak" },
        { name: "i" },
        { name: "g" },
      ],
    },
    { name: "a", version: "1.0.0", source: registry, dependencies: [{ name: "late" }] },
    { name: "b", version: "1.0.0", source: registry, dependencies: [] },
    { name: "c", version: "1.0.0", source: registry, dependencies: [{ name: "late" }] },
    { name: "d", version: "1.0.0", source: registry, dependencies: [] },
    { name: "e", version: "1.0.0", source: registry, dependencies: [] },
    { name: "macros", version: "1.0.0", source: registry, dependencies: [{ name: "syn" }] },
    { name: "syn", version: "2.0.0", source: registry, dependencies: [] },
    { name: "k", version: "1.2.0", source: registry, dependencies: [] },
    { name: "k", version: "2.0.1", source: registry, dependencies: [] },
    { name: "weak", version: "1.0.0", source: registry, dependencies: [] },
    { name: "i", version: "1.0.0", source: registry, dependencies: [{ name: "j" }] },
    { name: "j", version: "1.0.0", source: registry, dependencies: [] },
    { name: "g", version: "1.0.0", source: registry, dependencies: [] },
    { name: "late", version: "1.0.0", source: registry, dependencies: [{ name: "extra" }] },
    { name: "extra", version: "1.0.0", source: registry, dependencies: [] },
  ];
  const manifests: Record<string, string> = {
    app: [
      "[dependencies]",
      'a = "1"',
      'b = { version = "1", optional = true }',
      'c = { version = "1", default-features = false, features = ["one"] }',
      'macros = "1"',
      'k = "2"',
      'k1 = { package = "k", version = "1.2" }',
      'weak = { version = "1", optional = true }',
      'i = { version = "1", optional = true }',
      'g = { version = "1", optional = true }',
      "[target.'cfg(windows)'.dependencies]",
      'd = "1"',
      "[target.'cfg(unix)'.dependencies]",
      'e = "1"',
      "[features]",
      'default = ["dep:b", "c/two", "weak?/x", "i/y", "g"]',
    ].join("\n"),
    a: '[dependencies]\nlate = "1"',
    b: "",
    c: '[dependencies]\nlate = { version = "1", optional = true }\n[features]\ndefault = ["late"]\none = ["two"]\ntwo = []',
    d: "",
    e: "",
    macros: '[lib]\nproc-macro = true\n[dependencies]\nsyn = "2"',
    syn: "",
    k: "",
    weak: "",
    i: '[dependencies]\nj = { version = "1", optional = true }\n[features]\ny = ["dep:j"]',
    j: "",
    g: "",
    late: '[dependencies]\nextra = { version = "1", optional = true }\n[features]\nmore = ["dep:extra"]',
    extra: "",
  };
  const load = async (locked: Locked): Promise<Crate> => ({
    locked,
    manifest: parseManifest(
      `[package]\nname = "${locked.name}"\nversion = "${locked.version}"\n${manifests[locked.name]}`,
    ),
    files: null,
  });

  it("are what the platform compiles: features on, optional ones through them, no proc-macro or what it needs, the target's", async () => {
    const crates = await resolveCrates(lock, { name: "app", features: [] }, load);
    expect(crates.map((c) => `${c.locked.name} ${c.locked.version}`).sort()).toEqual([
      "a 1.0.0",
      "app 1.0.0",
      "b 1.0.0",
      "c 1.0.0",
      "e 1.0.0",
      "g 1.0.0",
      "i 1.0.0",
      "j 1.0.0",
      "k 1.2.0",
      "k 2.0.1",
      "late 1.0.0",
    ]);
  });

  it("follow a feature that arrives after its crate was read", async () => {
    // root reaches x and w first with their defaults; y, read after, asks x for f, which brings z.
    const graph: Locked[] = [
      {
        name: "root",
        version: "1.0.0",
        dependencies: [{ name: "x" }, { name: "y" }, { name: "w" }],
      },
      {
        name: "y",
        version: "1.0.0",
        source: registry,
        dependencies: [{ name: "x" }, { name: "w" }],
      },
      { name: "x", version: "1.0.0", source: registry, dependencies: [{ name: "z" }] },
      { name: "w", version: "1.0.0", source: registry, dependencies: [] },
      { name: "z", version: "1.0.0", source: registry, dependencies: [] },
    ];
    const tomls: Record<string, string> = {
      root: '[dependencies]\nx = "1"\ny = "1"\nw = "1"',
      y: '[dependencies]\nx = { version = "1", features = ["f"] }\nw = "1"',
      x: '[dependencies]\nz = { version = "1", optional = true }\n[features]\nf = ["dep:z"]',
      w: "",
      z: "",
    };
    const loads: string[] = [];
    const crates = await resolveCrates(graph, { name: "root", features: [] }, async (locked) => {
      loads.push(locked.name);
      return {
        locked,
        manifest: parseManifest(
          `[package]\nname = "${locked.name}"\nversion = "1.0.0"\n${tomls[locked.name]}`,
        ),
        files: null,
      };
    });
    expect(crates.map((c) => c.locked.name).sort()).toEqual(["root", "w", "x", "y", "z"]);
    // Each crate is read once, however often it is reached.
    expect(loads.sort()).toEqual(["root", "w", "x", "y", "z"]);
  });

  it("refuse a dependency the lock does not give, or gives twice over", async () => {
    const missing = lock.map((p) =>
      p.name === "app" ? { ...p, dependencies: p.dependencies.filter((d) => d.name !== "a") } : p,
    );
    await expect(resolveCrates(missing, { name: "app", features: [] }, load)).rejects.toThrow(
      "app 1.0.0 needs a 1, which Cargo.lock gives it 0 times",
    );
    const twice = lock.map((p) =>
      p.name === "app"
        ? { ...p, dependencies: [...p.dependencies, { name: "k", version: "2.0.9" }] }
        : p,
    );
    await expect(resolveCrates(twice, { name: "app", features: [] }, load)).rejects.toThrow(
      "app 1.0.0 needs k 2, which Cargo.lock gives it 2 times",
    );
    await expect(resolveCrates(lock, { name: "none", features: [] }, load)).rejects.toThrow(
      "Cargo.lock has 0 none",
    );
  });

  it.each([
    ["~1.2", true],
    ["=1.2.0", true],
    ["^1.2.0", true],
    ["0.1", false],
  ])("tell two locked versions apart by the requirement %s", async (req, picks) => {
    const two: Locked[] = [
      {
        name: "root",
        version: "1.0.0",
        dependencies: [
          { name: "k", version: "1.2.0" },
          { name: "k", version: "0.1.0" },
        ],
      },
      { name: "k", version: "1.2.0", source: registry, dependencies: [] },
      { name: "k", version: "0.1.0", source: registry, dependencies: [] },
    ];
    const crates = await resolveCrates(two, { name: "root", features: [] }, async (locked) => ({
      locked,
      manifest: parseManifest(
        `[package]\nname = "${locked.name}"\nversion = "${locked.version}"\n${locked.name === "root" ? `[dependencies]\nk = "${req}"` : ""}`,
      ),
      files: null,
    }));
    expect(crates.map((c) => c.locked.version)).toContain(picks ? "1.2.0" : "0.1.0");
  });

  it("refuse a requirement they cannot match", async () => {
    const two: Locked[] = [
      {
        name: "root",
        version: "1.0.0",
        dependencies: [
          { name: "k", version: "1.2.0" },
          { name: "k", version: "0.1.0" },
        ],
      },
    ];
    const root = {
      locked: two[0] as Locked,
      manifest: parseManifest(
        '[package]\nname = "root"\nversion = "1.0.0"\n[dependencies]\nk = ">=1, <2"',
      ),
      files: null,
    };
    await expect(
      resolveCrates(two, { name: "root", features: [] }, async () => root),
    ).rejects.toThrow("a requirement this cannot match: >=1, <2");
  });
});

describe("Rust in the shared library", () => {
  const commit = "75a75c3e0a67d3fa3d03982775f5bb0356e7b510";
  const strings = (...texts: string[]) =>
    Buffer.concat(texts.flatMap((t) => [Buffer.from(t, "latin1"), Buffer.from([0, 1, 0xff])]));

  it("is the standard library's commit and version, and the crates it was built with", () => {
    const binary = strings(
      "rustc version 1.101.0-nightly (75a75c3e0 2026-09-26)",
      `/rustc/${commit}/library/core/src/fmt/mod.rs`,
      `/rustc/${commit}/library/alloc/src/sync.rs`,
      "/cargo/registry/25cdd57fae9f0462/rustc-demangle-0.1.28/src/lib.rs",
      "/cargo/registry/25cdd57fae9f0462/rustc-demangle-0.1.28/src/v0.rs",
      "/cargo/registry/25cdd57fae9f0462/addr2line-0.27.1/src/line.rs",
      "/cargo/registry/25cdd57fae9f0462/no-version/src/lib.rs",
      "/cargo/registry/25cdd57fae9f0462/trailing-/src/lib.rs",
      "/cargo/registry/",
      "/cargo/registry/25cdd57fae9f0462/x-y-1.0.0-rc.1/src/lib.rs",
    );
    expect(rustOf(new Uint8Array(binary))).toEqual({
      commit,
      version: "1.101.0-nightly 2026-09-26",
      crates: [
        { name: "addr2line", version: "0.27.1" },
        { name: "rustc-demangle", version: "0.1.28" },
        { name: "x-y", version: "1.0.0-rc.1" },
      ],
    });
  });

  it.each([
    ["no rustc version", strings(`/rustc/${commit}/library/core/src/lib.rs`)],
    ["no standard library", strings("rustc version 1.101.0-nightly (75a75c3e0 2026-09-26)")],
    [
      "two standard libraries",
      strings(
        "rustc version 1.101.0-nightly (75a75c3e0 2026-09-26)",
        `/rustc/${commit}/a.rs`,
        `/rustc/${"0".repeat(40)}/b.rs`,
      ),
    ],
    [
      "another standard library",
      strings("rustc version 1.101.0-nightly (123456789 2026-09-26)", `/rustc/${commit}/a.rs`),
    ],
  ])("is refused with %s", (_, binary) => {
    expect(() => rustOf(new Uint8Array(binary))).toThrow("names no one Rust standard library");
  });
});

describe("the licences a crate is used under", () => {
  it.each([
    ["MIT", ["MIT"], false],
    ["Apache-2.0", ["Apache-2.0"], false],
    ["MIT OR Apache-2.0", ["MIT"], true],
    ["MIT/Apache-2.0", ["MIT"], true],
    ["Zlib OR Apache-2.0 OR MIT", ["MIT"], true],
    ["(Apache-2.0 OR MIT) AND BSD-3-Clause", ["MIT", "BSD-3-Clause"], true],
    ["BSD-3-Clause OR Apache-2.0", ["BSD-3-Clause"], true],
    ["MIT AND Apache-2.0", ["MIT", "Apache-2.0"], false],
  ])("%s: %j", (expression, ids, chosen) => {
    expect(usedLicences(expression)).toMatchObject({ ids, chosen });
  });

  it("name every licence the expression offers, and refuse one with no rule to choose", () => {
    expect(usedLicences("(Apache-2.0 OR MIT) AND BSD-3-Clause").all).toEqual([
      "Apache-2.0",
      "BSD-3-Clause",
      "MIT",
    ]);
    expect(() => usedLicences("Apache-2.0 OR Zlib")).toThrow(
      'no choice made for "Apache-2.0 OR Zlib"',
    );
  });
});

describe("a tag's commit, as git ls-remote answers", () => {
  it("is the peeled commit of an annotated tag, or the tag's own", () => {
    const annotated = "e9ad8b2c\trefs/tags/2.63.2\n07332662\trefs/tags/2.63.2^{}\n";
    expect(lsRemoteCommit(annotated, "2.63.2")).toBe("07332662");
    expect(lsRemoteCommit("24ad4d04\trefs/tags/v8.18.7\n", "v8.18.7")).toBe("24ad4d04");
    expect(() => lsRemoteCommit("", "v1")).toThrow("no tag v1");
  });
});

// --- whole releases ---------------------------------------------------------------

const VERSION = "1.3.4";
const RAW = "https://raw.githubusercontent.com";
const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";
const STD = "75a75c3e0a67d3fa3d03982775f5bb0356e7b510";
const commitOf = (repository: string, ref: string) => sha1(`${repository}@${ref}`);

/** Every key of the real LIBRARIES at a version, and one the platform does not build. */
const VERSIONS: Record<string, string> = {
  ...Object.fromEntries(Object.keys(LIBRARIES).map((key) => [key, "1.0.0"])),
  mozjpeg: "0826579",
  rsvg: "2.63.2",
  vips: "8.18.7",
  "proxy-libintl": "0.5",
};

/** The fixture's crates: name, version, license, its other files. */
const CRATES: Array<[string, string, string, Record<string, string>, string?]> = [
  // librsvg-c → librsvg → image (png, not gif), cssparser, selectors, pxfm, aho, icu, miniz_oxide 0.9.1
  [
    "image",
    "0.25.0",
    "MIT OR Apache-2.0",
    {
      "LICENSE-MIT": `Copyright (c) image\n\n${MIT_WRAPPED}`,
      "LICENSE-APACHE": APACHE,
      "src/lib.rs": "",
    },
    '[dependencies.png]\nversion = "0.18"\noptional = true\n[dependencies.gif]\nversion = "0.13"\noptional = true\n[dependencies.image-derive]\nversion = "1"\n[features]\npng = ["dep:png"]\ngif = ["dep:gif"]\nwebp = []',
  ],
  [
    "png",
    "0.18.0",
    "MIT/Apache-2.0",
    {
      COPYRIGHT:
        "Copyright 2015 nwin.\n\nLicensed under the Apache License or the MIT license, at your option.",
    },
  ],
  ["gif", "0.13.0", "MIT", { LICENSE: MIT }],
  ["image-derive", "1.0.0", "MIT", { LICENSE: MIT }, "[lib]\nproc-macro = true"],
  ["cssparser", "0.37.0", "MPL-2.0", { LICENSE: MPL }],
  ["selectors", "0.40.0", "MPL-2.0", {}],
  [
    "pxfm",
    "0.1.30",
    "BSD-3-Clause OR Apache-2.0",
    {
      "LICENSE.md": `Copyright (c) Radzivon Bartoshyk. All rights reserved.\n\n${BSD3}`,
      "LICENSE-APACHE.md": APACHE,
    },
  ],
  [
    "aho-corasick",
    "1.1.5",
    "Unlicense OR MIT",
    {
      COPYING: "This project is dual-licensed under the Unlicense and MIT licenses.",
      UNLICENSE: "This is free and unencumbered software released into the public domain.",
      "LICENSE-MIT": `Copyright (c) 2015 Andrew Gallant\n\n${MIT_OTHER}`,
    },
  ],
  ["icu_collections", "2.3.0", "Unicode-3.0", { LICENSE: UNICODE }],
  ["miniz_oxide", "0.8.9", "MIT OR Zlib OR Apache-2.0", { "LICENSE-MIT.md": MIT }],
  [
    "miniz_oxide",
    "0.9.1",
    "MIT OR Zlib OR Apache-2.0",
    {
      "LICENSE-MIT.md": `Copyright (c) 2017 Frommi\n\n${MIT}`,
      LICENSE: `Copyright (c) 2017 Frommi\n\n${MIT}`,
      "LICENSE-ZLIB.md": "zlib",
    },
  ],
  [
    "encoding_rs",
    "0.8.41",
    "(Apache-2.0 OR MIT) AND BSD-3-Clause",
    {
      "LICENSE-MIT": `Copyright Mozilla Foundation\n\n${MIT}`,
      "LICENSE-WHATWG": `Copyright © WHATWG\n\n${BSD3_OTHER}`,
      COPYRIGHT: "encoding_rs is copyright Mozilla Foundation.",
    },
  ],
  // The standard library's, read from the binary.
  [
    "gimli",
    "0.34.0",
    "MIT OR Apache-2.0",
    { "LICENSE-MIT": `Copyright (c) 2015 The Rust Project Developers\n\n${MIT}` },
  ],
];

const crateBytes = new Map(
  CRATES.map(([name, version, license, others, extra = ""]) => [
    `${name} ${version}`,
    crate(name, version, `license = "${license}"\n${extra}`, others),
  ]),
);

function cargoLock(): string {
  const entry = (name: string, version: string, deps: string[] = []) => {
    const bytes = crateBytes.get(`${name} ${version}`);
    return [
      "[[package]]",
      `name = "${name}"`,
      `version = "${version}"`,
      ...(bytes ? [`source = "${REGISTRY}"`, `checksum = "${sha256(bytes)}"`] : []),
      `dependencies = [${deps.map((d) => `"${d}"`).join(", ")}]`,
    ].join("\n");
  };
  return [
    "version = 4",
    entry("librsvg-c", "2.63.2", ["librsvg"]),
    entry("librsvg", "2.63.2", [
      "image",
      "cssparser",
      "selectors",
      "pxfm",
      "aho-corasick",
      "icu_collections",
      "miniz_oxide 0.8.9",
      "miniz_oxide 0.9.1",
      "encoding_rs",
    ]),
    entry("image", "0.25.0", ["png", "gif", "image-derive"]),
    entry("png", "0.18.0"),
    entry("gif", "0.13.0"),
    entry("image-derive", "1.0.0"),
    entry("cssparser", "0.37.0"),
    entry("selectors", "0.40.0"),
    entry("pxfm", "0.1.30"),
    entry("aho-corasick", "1.1.5"),
    entry("icu_collections", "2.3.0"),
    entry("miniz_oxide", "0.8.9"),
    entry("miniz_oxide", "0.9.1"),
    entry("encoding_rs", "0.8.41"),
  ].join("\n\n");
}

const POSIX = [
  "#!/usr/bin/env bash",
  `if [ "\${PLATFORM%-*}" == "linuxmusl" ] || [ "$DARWIN" = true ]; then`,
  `  mkdir \${DEPS}/proxy-libintl`,
  `  $CURL https://github.com/frida/proxy-libintl/archive/\${VERSION_PROXY_LIBINTL}.tar.gz | tar xzC \${DEPS}/proxy-libintl`,
  "fi",
  ...Object.keys(LIBRARIES).flatMap((key) => {
    const variable = `VERSION_${key.toUpperCase().replaceAll("-", "_")}`;
    const lines = [
      `mkdir \${DEPS}/${key}`,
      `$CURL https://releases.example/${key}-\${${variable}}.tar.gz | tar xzC \${DEPS}/${key}`,
    ];
    if (key === "vips")
      lines.push("$CURL https://gist.example/libvips-cpp-soversion.patch | patch -p1");
    if (key === "rsvg") {
      lines.push(`sed -i'.bak' "/image = /s/, \\"gif\\", \\"webp\\"//" rsvg/Cargo.toml`);
      lines.push("$CURL https://github.com/GNOME/librsvg/commit/9106011.patch | patch -p1");
    }
    return lines;
  }),
].join("\n");

const NOTICES = [
  "| Library | Used under the terms of |",
  "|---|---|",
  ...Object.values(LIBRARIES).flatMap((row) =>
    [row, ...(row.vendored ?? [])].map(
      (r) => `| ${r.row ?? r.name} | ${r.lgpl ? "LGPLv3" : "MIT License"} |`,
    ),
  ),
  "| proxy-libintl | LGPLv3 |",
].join("\n");

function binary(): Uint8Array {
  return Buffer.concat(
    [
      "rustc version 1.101.0-nightly (75a75c3e0 2026-09-26)",
      `/rustc/${STD}/library/core/src/fmt/mod.rs`,
      "/cargo/registry/25cdd57fae9f0462/gimli-0.34.0/src/read/line.rs",
      "/cargo/registry/25cdd57fae9f0462/miniz_oxide-0.9.1/src/inflate/core.rs",
    ].flatMap((t) => [Buffer.from(t), Buffer.from([0, 7])]),
  );
}

function npmPackage(versions: Record<string, string> = VERSIONS, so: Uint8Array | null = binary()) {
  const entries: Entry[] = [
    { name: "package/package.json", body: '{"name":"@img/sharp-libvips-linux-arm64"}' },
    { name: "package/versions.json", body: JSON.stringify(versions) },
  ];
  if (so) entries.push({ name: "package/lib/libvips-cpp.so.8.18.7", body: so });
  return gzipSync(tar(entries));
}

/** The addresses of a release whose libraries are LIBRARIES' rows, every licence file of theirs a plain MIT one unless named here. */
function release(): Map<string, string | Uint8Array> {
  const tag = `${RAW}/lovell/sharp-libvips/v${VERSION}`;
  const tarball = npmPackage();
  const rsvg = (file: string) =>
    `${RAW}/GNOME/librsvg/${commitOf("https://github.com/GNOME/librsvg", "2.63.2")}/${file}`;
  const freetype = (file: string) =>
    `${RAW}/freetype/freetype/${commitOf("https://github.com/freetype/freetype", "VER-1-0-0")}/${file}`;
  const mozjpeg = (file: string) =>
    `${RAW}/mozilla/mozjpeg/${commitOf("https://github.com/mozilla/mozjpeg", "0826579")}/${file}`;
  const libpng = `${RAW}/pnggroup/libpng/${commitOf("https://github.com/pnggroup/libpng", "v1.0.0")}/LICENSE`;
  return new Map<string, string | Uint8Array>([
    [
      `${tag}/versions.properties`,
      Object.entries(VERSIONS)
        .map(([k, version]) => `VERSION_${k.toUpperCase().replaceAll("-", "_")}=${version}`)
        .join("\n"),
    ],
    [
      `${tag}/platforms/linux-arm64v8/Dockerfile`,
      'FROM rockylinux\nENV \\\n  PLATFORM="linux-arm64v8"\n',
    ],
    [`${tag}/build/posix.sh`, POSIX],
    [`${tag}/THIRD-PARTY-NOTICES.md`, NOTICES],
    [
      "https://registry.npmjs.org/@img/sharp-libvips-linux-arm64/1.3.4",
      JSON.stringify({
        dist: {
          tarball:
            "https://registry.npmjs.org/@img/sharp-libvips-linux-arm64/-/sharp-libvips-linux-arm64-1.3.4.tgz",
          integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
        },
      }),
    ],
    [
      "https://registry.npmjs.org/@img/sharp-libvips-linux-arm64/-/sharp-libvips-linux-arm64-1.3.4.tgz",
      tarball,
    ],
    ["https://www.gnu.org/licenses/lgpl-3.0.txt", `\n${LGPL}  \r\n`],
    ["https://www.gnu.org/licenses/gpl-3.0.txt", GPL],
    [
      freetype("docs/FTL.TXT"),
      "The FreeType Project LICENSE\n\n    Portions of this software are copyright © <year> The FreeType\n    Project (https://freetype.org).  All rights reserved.",
    ],
    [freetype("README"), "FreeType 2\n\nCopyright (C) 2006-2026 by\nDavid Turner."],
    [
      mozjpeg("LICENSE.md"),
      "libjpeg-turbo Licenses\n\n        This software is based in part on the work of the Independent JPEG\n        Group.",
    ],
    [
      libpng,
      "COPYRIGHT NOTICE, DISCLAIMER, and LICENSE\n\nCopyright (c) 1995-2025 The PNG Reference Library Authors.\n\nPermission granted.",
    ],
    [
      rsvg("Cargo.toml"),
      '[workspace]\nmembers = ["rsvg", "librsvg-c"]\n[workspace.package]\nversion = "2.63.2"\nlicense = "LGPL-2.1-or-later"\n[workspace.dependencies]\nlibrsvg = { path = "rsvg" }\nimage = { version = "0.25.0", default-features = false }\ncssparser = "0.37.0"\nunused = "1"',
    ],
    [rsvg("Cargo.lock"), cargoLock()],
    [
      rsvg("librsvg-c/Cargo.toml"),
      '[package]\nname = "librsvg-c"\nversion.workspace = true\n[dependencies]\nlibrsvg = { workspace = true }',
    ],
    [
      rsvg("rsvg/Cargo.toml"),
      [
        '[package]\nname = "librsvg"\nversion = "2.63.2"\n[dependencies]',
        'image = { workspace = true, features = ["png", "gif", "webp"] }',
        "cssparser.workspace = true",
        'selectors = "0.40.0"',
        'pxfm = "0.1"',
        'aho-corasick = "1"',
        'icu_collections = "2"',
        'miniz_oxide = "0.9"',
        'miniz8 = { package = "miniz_oxide", version = "0.8" }',
        'encoding_rs = "0.8"',
      ].join("\n"),
    ],
    [
      "https://github.com/GNOME/librsvg/commit/9106011.patch",
      "From 9106011\n\ndiff --git a/rsvg/src/api.rs b/rsvg/src/api.rs\n--- a/rsvg/src/api.rs\n",
    ],
    ...[...crateBytes].map(([id, bytes]): [string, Uint8Array] => {
      const [name, version] = id.split(" ") as [string, string];
      return [`https://static.crates.io/crates/${name}/${name}-${version}.crate`, bytes];
    }),
    [
      `${RAW}/rust-lang/rust/${STD}/COPYRIGHT`,
      "Short version for non-lawyers:\n\nThe Rust Project is dual-licensed under Apache 2.0 and MIT terms.",
    ],
    [
      `${RAW}/rust-lang/rust/${STD}/LICENSE-MIT`,
      `Copyright (c) The Rust Project Contributors\n\n${MIT}`,
    ],
    [
      `${RAW}/nodejs/node-addon-api/${commitOf("https://github.com/nodejs/node-addon-api", "v8.9.2")}/LICENSE.md`,
      `The MIT License (MIT)\n\nCopyright (c) 2017 Node.js API collaborators\n\n${MIT_WRAPPED}`,
    ],
  ]);
}

/** A licence file of a library repository, served when the release names none of its own: an MIT one, base64 from gitiles. */
const anyLicence = (url: string) => {
  const text = `Copyright (c) 2026 ${url.split("/").at(-1)} authors\n\n${MIT}`;
  if (url.startsWith("https://aomedia.googlesource.com/")) {
    return url.endsWith("?format=TEXT") ? Buffer.from(text).toString("base64") : undefined;
  }
  return /^https:\/\/(raw\.githubusercontent\.com|gitlab\.freedesktop\.org|gitlab\.com)\//.test(url)
    ? text
    : undefined;
};

const SHARP = { version: "0.35.5", devDependencies: { "node-addon-api": "^8.9.2" } };

describe("a release, gathered", () => {
  it("is libvips, the libraries by name, Rust's standard library and its crates, librsvg's crates, then the addon's", async () => {
    const part = await gatherLibvips(VERSION, SHARP, served(release(), anyLicence));
    expect(part).toMatchObject({
      package: "@img/sharp-libvips-linux-arm64",
      version: "1.3.4",
      build: "https://github.com/lovell/sharp-libvips/tree/v1.3.4",
      versions: VERSIONS,
      lgpl: textKey(LGPL),
      gpl: textKey(GPL),
      mpl2: textKey(MPL),
    });
    const names = part.libraries.map((l) => l.name);
    expect(names.slice(0, 2)).toEqual(["libvips", "aom"]);
    expect(names.slice(-14)).toEqual([
      "zlib-ng",
      "Rust's standard library (in librsvg)",
      "gimli (Rust crate in Rust's standard library, in librsvg)",
      "aho-corasick (Rust crate in librsvg)",
      "cssparser (Rust crate in librsvg)",
      "encoding_rs (Rust crate in librsvg)",
      "icu_collections (Rust crate in librsvg)",
      "image (Rust crate in librsvg)",
      "miniz_oxide (Rust crate in librsvg)",
      "miniz_oxide (Rust crate in librsvg)",
      "png (Rust crate in librsvg)",
      "pxfm (Rust crate in librsvg)",
      "selectors (Rust crate in librsvg)",
      "node-addon-api (in sharp's addon)",
    ]);
    // The rows, libnsgif, the standard library, its one crate, librsvg's ten, the addon's.
    expect(names).toHaveLength(Object.keys(LIBRARIES).length + 1 + 1 + 1 + 10 + 1);
    expect(
      part.libraries.filter((l) => l.name.startsWith("miniz_oxide")).map((l) => l.version),
    ).toEqual(["0.8.9", "0.9.1"]);
    expect(names).not.toContain("gif (Rust crate in librsvg)");
    expect(names).not.toContain("image-derive (Rust crate in librsvg)");
    expect(names).not.toContain("proxy-libintl");
    // Every text it names is there, and none it does not.
    const named = [
      part.lgpl,
      part.gpl,
      part.mpl2,
      ...part.libraries.flatMap((l) => l.licences.map((x) => x.text)),
    ];
    expect(Object.keys(part.texts).sort()).toEqual([...new Set(named)].sort());
  });

  it("names each library's release and patches, and reads its licence at the commit of its version's tag", async () => {
    const part = await gatherLibvips(VERSION, SHARP, served(release(), anyLicence));
    const of = (name: string) => part.libraries.find((l) => l.name === name);
    expect(of("libvips")).toEqual({
      name: "libvips",
      version: "8.18.7",
      license: "LGPL-2.1-or-later, used under LGPL-3.0",
      source: [
        "https://releases.example/vips-8.18.7.tar.gz",
        "https://gist.example/libvips-cpp-soversion.patch",
      ],
      licences: [
        {
          file: null,
          from: "https://www.gnu.org/licenses/lgpl-3.0.txt",
          copyright: [],
          text: textKey(LGPL),
        },
      ],
    });
    expect(part.texts[textKey(LGPL)]).toBe(LGPL);
    expect(of("libnsgif (in libvips)")).toMatchObject({
      version: "8.18.7",
      source: ["https://releases.example/vips-8.18.7.tar.gz"],
      licences: [
        {
          from: `${RAW}/libvips/libvips/${commitOf("https://github.com/libvips/libvips", "v8.18.7")}/libvips/foreign/libnsgif/COPYING`,
          copyright: ["Copyright (c) 2026 COPYING authors"],
          text: textKey(MIT),
        },
      ],
    });
    expect(of("aom")?.licences.map((l) => l.from)).toEqual(
      ["LICENSE", "PATENTS"].map(
        (f) =>
          `https://aomedia.googlesource.com/aom/+/${commitOf("https://aomedia.googlesource.com/aom", "v1.0.0")}/${f}`,
      ),
    );
    expect(of("aom")?.licences[0]?.copyright).toEqual([
      "Copyright (c) 2026 LICENSE?format=TEXT authors",
    ]);
    expect(of("cairo")?.licences[0]?.from).toBe(
      `https://gitlab.freedesktop.org/cairo/cairo/-/raw/${commitOf("https://gitlab.freedesktop.org/cairo/cairo.git", "1.0.0")}/COPYING`,
    );
    expect(of("libtiff")?.licences[0]?.from).toBe(
      `https://gitlab.com/libtiff/libtiff/-/raw/${commitOf("https://gitlab.com/libtiff/libtiff.git", "v1.0.0")}/LICENSE.md`,
    );
    expect(of("expat")?.licences[0]?.from).toContain(
      commitOf("https://github.com/libexpat/libexpat", "R_1_0_0"),
    );
    expect(of("lcms2")?.licences[0]?.from).toContain(
      commitOf("https://github.com/mm2/Little-CMS", "lcms1.0.0"),
    );
    expect(of("pixman")?.licences[0]?.from).toContain(
      commitOf("https://gitlab.freedesktop.org/pixman/pixman.git", "pixman-1.0.0"),
    );
  });

  it("keeps FreeType's and the IJG's credits as copyright lines, and libpng's licence whole", async () => {
    const part = await gatherLibvips(VERSION, SHARP, served(release(), anyLicence));
    const of = (name: string) => part.libraries.find((l) => l.name === name);
    expect(of("freetype")?.licences[1]?.copyright).toEqual([
      "Portions of this software are copyright © 2026 The FreeType Project (https://freetype.org). All rights reserved.",
    ]);
    expect(of("mozjpeg")?.licences[0]?.copyright).toEqual([
      "This software is based in part on the work of the Independent JPEG Group.",
    ]);
    const png = of("libpng")?.licences[0];
    expect(png?.copyright).toEqual([]);
    expect(part.texts[png?.text as string]).toMatch(/^COPYRIGHT NOTICE, DISCLAIMER, and LICENSE\n/);
  });

  it("gives each crate the files of the licences it is used under, and owes it the text it does not carry", async () => {
    const part = await gatherLibvips(VERSION, SHARP, served(release(), anyLicence));
    const of = (name: string) =>
      part.libraries.find((l) => l.name === `${name} (Rust crate in librsvg)`);
    const url = (name: string, version: string) =>
      `https://static.crates.io/crates/${name}/${name}-${version}.crate`;
    expect(of("image")).toEqual({
      name: "image (Rust crate in librsvg)",
      version: "0.25.0",
      license: "MIT OR Apache-2.0, used under MIT",
      source: [url("image", "0.25.0")],
      licences: [
        {
          file: null,
          from: `${url("image", "0.25.0")} (LICENSE-MIT)`,
          copyright: ["Copyright (c) image"],
          text: textKey(MIT),
        },
      ],
    });
    // The first library in the part's order that names a text gives its copy: aom's, not image's wrapping.
    expect(part.texts[textKey(MIT)]).toBe(MIT);
    expect(of("png")).toMatchObject({
      license: "MIT OR Apache-2.0, used under MIT",
      licences: [
        { from: `${url("png", "0.18.0")} (COPYRIGHT)`, copyright: ["Copyright 2015 nwin."] },
        {
          from: `${url("png", "0.18.0")} (the MIT licence its COPYRIGHT names, which the crate does not carry)`,
          copyright: [],
          text: textKey(MIT),
        },
      ],
    });
    expect(of("selectors")?.licences).toEqual([
      { file: null, from: url("selectors", "0.40.0"), copyright: [], text: textKey(MPL) },
    ]);
    expect(of("pxfm")).toMatchObject({
      license: "BSD-3-Clause OR Apache-2.0, used under BSD-3-Clause",
      licences: [{ from: `${url("pxfm", "0.1.30")} (LICENSE.md)`, text: textKey(BSD3) }],
    });
    expect(of("aho-corasick")?.licences.map((l) => l.from)).toEqual([
      `${url("aho-corasick", "1.1.5")} (LICENSE-MIT)`,
    ]);
    expect(of("icu_collections")).toMatchObject({
      license: "Unicode-3.0",
      licences: [{ text: textKey(UNICODE), copyright: [] }],
    });
    const miniz = part.libraries.find(
      (l) => l.name.startsWith("miniz_oxide") && l.version === "0.9.1",
    );
    expect(miniz?.licences.map((l) => l.from)).toEqual([
      `${url("miniz_oxide", "0.9.1")} (LICENSE-MIT.md)`,
      `${url("miniz_oxide", "0.9.1")} (LICENSE)`,
    ]);
    expect(of("encoding_rs")?.licences.map((l) => l.from?.replace(/.* \(/, "("))).toEqual([
      "(LICENSE-MIT)",
      "(LICENSE-WHATWG)",
      "(COPYRIGHT)",
    ]);
    expect(part.libraries.find((l) => l.name.startsWith("gimli"))).toMatchObject({
      license: "MIT OR Apache-2.0, used under MIT",
      licences: [{ copyright: ["Copyright (c) 2015 The Rust Project Developers"] }],
    });
  });

  it("names Rust's standard library by the binary's commit, and the addon's node-addon-api by sharp's", async () => {
    const part = await gatherLibvips(VERSION, SHARP, served(release(), anyLicence));
    expect(part.libraries.find((l) => l.name.startsWith("Rust's"))).toMatchObject({
      version: "1.101.0-nightly 2026-09-26",
      source: [`https://github.com/rust-lang/rust/tree/${STD}`],
      licences: [
        { from: `${RAW}/rust-lang/rust/${STD}/COPYRIGHT`, copyright: [] },
        { copyright: ["Copyright (c) The Rust Project Contributors"], text: textKey(MIT) },
      ],
    });
    expect(part.libraries.at(-1)).toMatchObject({
      name: "node-addon-api (in sharp's addon)",
      version: "8.9.2",
      source: ["https://github.com/nodejs/node-addon-api/tree/v8.9.2"],
      licences: [
        { copyright: ["Copyright (c) 2017 Node.js API collaborators"], text: textKey(MIT) },
      ],
    });
  });

  const npm =
    "https://registry.npmjs.org/@img/sharp-libvips-linux-arm64/-/sharp-libvips-linux-arm64-1.3.4.tgz";
  const meta = "https://registry.npmjs.org/@img/sharp-libvips-linux-arm64/1.3.4";
  const withPackage = (table: Map<string, string | Uint8Array>, tarball: Uint8Array) => {
    table.set(npm, tarball);
    table.set(
      meta,
      JSON.stringify({
        dist: {
          tarball: npm,
          integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
        },
      }),
    );
  };
  const tag = `${RAW}/lovell/sharp-libvips/v${VERSION}`;
  const rsvg = (file: string) =>
    `${RAW}/GNOME/librsvg/${commitOf("https://github.com/GNOME/librsvg", "2.63.2")}/${file}`;

  it.each<[string, (table: Map<string, string | Uint8Array>) => void, string]>([
    [
      "a package the registry does not name",
      (t) => t.set(npm, gzipSync(tar([]))),
      "is not the package the registry names",
    ],
    [
      "a package of other versions",
      (t) => withPackage(t, npmPackage({ ...VERSIONS, aom: "9" })),
      "versions.json is not versions.properties of v1.3.4",
    ],
    [
      "a package without libvips",
      (t) => withPackage(t, npmPackage(VERSIONS, null)),
      "holds no libvips-cpp.so",
    ],
    [
      "a library the table has no row for",
      (t) => {
        t.set(
          `${tag}/build/posix.sh`,
          `${POSIX}\nmkdir \${DEPS}/new\n$CURL https://x.example/\${VERSION_NEW}.tar.gz | tar xz`,
        );
        t.set(
          `${tag}/versions.properties`,
          `${t.get(`${tag}/versions.properties`)}\nVERSION_NEW=1`,
        );
        withPackage(t, npmPackage({ ...VERSIONS, new: "1" }));
      },
      "build/posix.sh builds new, which LIBRARIES has no row for: add one",
    ],
    [
      "a row the build no longer needs",
      (t) => t.set(`${tag}/build/posix.sh`, POSIX.replace(/mkdir \$\{DEPS\}\/cgif\n[^\n]*\n/, "")),
      "LIBRARIES has a row the build no longer needs: cgif",
    ],
    [
      "a library sharp-libvips does not name",
      (t) => t.set(`${tag}/THIRD-PARTY-NOTICES.md`, NOTICES.replace("| cgif |", "| other |")),
      "sharp-libvips' THIRD-PARTY-NOTICES.md names no cgif",
    ],
    [
      "an LGPL library sharp-libvips does not use under LGPL-3.0",
      (t) =>
        t.set(
          `${tag}/THIRD-PARTY-NOTICES.md`,
          NOTICES.replace("| glib | LGPLv3 |", "| glib | MIT License |"),
        ),
      "sharp-libvips uses glib under MIT License, its row under LGPL-2.1-or-later, used under LGPL-3.0",
    ],
    [
      "a library sharp-libvips uses under LGPL-3.0",
      (t) =>
        t.set(
          `${tag}/THIRD-PARTY-NOTICES.md`,
          NOTICES.replace("| cgif | MIT License |", "| cgif | LGPLv3 |"),
        ),
      "sharp-libvips uses cgif under LGPLv3, its row under MIT",
    ],
    [
      "an empty licence file",
      (t) =>
        t.set(
          `${RAW}/dloebl/cgif/${commitOf("https://github.com/dloebl/cgif", "v1.0.0")}/LICENSE`,
          "\n\n",
        ),
      "cgif's LICENSE is empty at",
    ],
    [
      "a FreeType README without the year",
      (t) =>
        t.set(
          `${RAW}/freetype/freetype/${commitOf("https://github.com/freetype/freetype", "VER-1-0-0")}/README`,
          "FreeType",
        ),
      "freetype's README gives no year for the FTL's credit",
    ],
    [
      "an FTL without its credit",
      (t) =>
        t.set(
          `${RAW}/freetype/freetype/${commitOf("https://github.com/freetype/freetype", "VER-1-0-0")}/docs/FTL.TXT`,
          "The FTL",
        ),
      'docs/FTL.TXT no longer says "Portions of this software … All rights reserved."',
    ],
    [
      "a patch to librsvg's Cargo files",
      (t) =>
        t.set(
          "https://github.com/GNOME/librsvg/commit/9106011.patch",
          "diff --git a/Cargo.lock b/Cargo.lock\ndiff --git a/rsvg/Cargo.toml b/rsvg/Cargo.toml\n",
        ),
      "9106011.patch changes Cargo.lock, rsvg/Cargo.toml, which the resolution does not apply",
    ],
    [
      "a crate that is not the lock's",
      (t) =>
        t.set(
          "https://static.crates.io/crates/png/png-0.18.0.crate",
          crate("png", "0.18.0", 'license = "MIT"'),
        ),
      "png-0.18.0.crate is not the one Cargo.lock names",
    ],
    [
      "a crate from elsewhere",
      (t) =>
        t.set(
          rsvg("Cargo.lock"),
          cargoLock().replace(
            `name = "png"\nversion = "0.18.0"\nsource = "${REGISTRY}"`,
            'name = "png"\nversion = "0.18.0"\nsource = "git+https://example.test/png"',
          ),
        ),
      "png 0.18.0 comes from git+https://example.test/png, not crates.io",
    ],
    [
      "a member the workspace does not name",
      (t) =>
        t.set(
          rsvg("Cargo.lock"),
          cargoLock().replace(
            `name = "png"\nversion = "0.18.0"\nsource = "${REGISTRY}"`,
            'name = "png"\nversion = "0.18.0"',
          ),
        ),
      "librsvg's workspace member png was not read",
    ],
    [
      "a crate with no licence",
      (t) => {
        const bytes = crate("gimli", "0.34.0", "");
        t.set("https://static.crates.io/crates/gimli/gimli-0.34.0.crate", bytes);
      },
      "gimli 0.34.0 names no licence in its Cargo.toml",
    ],
    [
      "a crate with no manifest",
      (t) =>
        t.set(
          "https://static.crates.io/crates/gimli/gimli-0.34.0.crate",
          gzipSync(tar(files({ "gimli-0.34.0/LICENSE": MIT }))),
        ),
      "gimli-0.34.0.crate holds no Cargo.toml",
    ],
    [
      "a licence no crate carries the text of",
      (t) => {
        const bytes = crate("icu_collections", "2.3.0", 'license = "Unicode-3.0"');
        t.set("https://static.crates.io/crates/icu_collections/icu_collections-2.3.0.crate", bytes);
        t.set(
          rsvg("Cargo.lock"),
          cargoLock().replace(
            /(name = "icu_collections"\nversion = "2.3.0"\nsource = "[^"]*"\nchecksum = ")[0-9a-f]+/,
            `$1${sha256(bytes)}`,
          ),
        );
      },
      "icu_collections (Rust crate in librsvg) owes Unicode-3.0's text, which no crate carries",
    ],
    [
      "no crate under MPL-2.0",
      (t) =>
        t.set(
          rsvg("rsvg/Cargo.toml"),
          String(t.get(rsvg("rsvg/Cargo.toml"))).replace(
            'cssparser.workspace = true\nselectors = "0.40.0"\n',
            "",
          ),
        ),
      "no crate carries MPL-2.0's text",
    ],
  ])("fails on %s", async (_, change, message) => {
    const table = release();
    change(table);
    await expect(gatherLibvips(VERSION, SHARP, served(table, anyLicence))).rejects.toThrow(message);
  });

  it("fails on a sharp that names no node-addon-api", async () => {
    await expect(
      gatherLibvips(VERSION, { version: "0.36.0" }, served(release(), anyLicence)),
    ).rejects.toThrow("sharp 0.36.0 names no node-addon-api");
  });

  it("fails on a table that does not say where a library's licence or librsvg's Cargo files are", async () => {
    const rows = (changes: Record<string, Row>) => ({ ...LIBRARIES, ...changes });
    const source = () => served(release(), anyLicence);
    await expect(
      gatherLibvips(VERSION, SHARP, source(), rows({ cgif: { name: "cgif", license: "MIT" } })),
    ).rejects.toThrow("cgif's row names no repository and files");
    await expect(
      gatherLibvips(
        VERSION,
        SHARP,
        source(),
        rows({
          rsvg: { name: "librsvg", license: "LGPL-2.1-or-later, used under LGPL-3.0", lgpl: true },
        }),
      ),
    ).rejects.toThrow("librsvg's row names no repository for its Cargo files");
  });

  it("fails on a build without librsvg, whose Rust the part is made for", async () => {
    const table = release();
    table.set(
      `${tag}/build/posix.sh`,
      POSIX.replace(/mkdir \$\{DEPS\}\/rsvg\n(?:[^\n]*\n){3}/, ""),
    );
    const { rsvg: _, ...rows } = LIBRARIES;
    await expect(gatherLibvips(VERSION, SHARP, served(table, anyLicence), rows)).rejects.toThrow(
      "build/posix.sh builds no librsvg",
    );
  });
});
