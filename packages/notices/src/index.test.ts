import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  blocksOf,
  collectNotices,
  licenseOf,
  normaliseText,
  providerOf,
  shippedFilesOf,
  shippedPackageDirs,
  splitNotice,
  textKey,
} from "./index.ts";

const MIT_BODY = [
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  'of this software and associated documentation files (the "Software"), to deal',
  "in the Software without restriction.",
  "",
  "The above copyright notice and this permission notice shall be included in all",
  "copies or substantial portions of the Software.",
].join("\n");
const ISC_BODY =
  "Permission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee is hereby granted.";
const APACHE = [
  "                                 Apache License",
  "                           Version 2.0, January 2004",
  "",
  "   1. Definitions.",
  "",
  "   END OF TERMS AND CONDITIONS",
  "",
  "   Copyright 2022 Joe Bell",
].join("\n");
const words = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

let root = "";
/** A package directory under the test's root with its package.json and files. */
function pkg(dir: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const at = join(root, dir);
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "package.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(at, name), text);
  return at;
}
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kuutti-notices-test-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the licence a package.json declares", () => {
  it("reads a string, an object with a type, a list of either, and says unknown when there is none", () => {
    expect(licenseOf({ license: "MIT" })).toBe("MIT");
    expect(licenseOf({ license: { type: "ISC", url: "https://example.invalid/isc" } })).toBe("ISC");
    expect(licenseOf({ licenses: [{ type: "MIT" }, "Apache-2.0"] })).toBe("MIT OR Apache-2.0");
    expect(licenseOf({ license: "MIT", licenses: [{ type: "ISC" }] })).toBe("MIT");
    expect(licenseOf({})).toBe("unknown");
    expect(licenseOf({ license: 7 })).toBe("unknown");
    expect(licenseOf({ license: { url: "https://example.invalid" } })).toBe("unknown");
  });
});

describe("who provides a package (#512)", () => {
  const ann = { name: "Ann Example", email: "ann@example.invalid" };

  it("is the npm scope, before anything the package.json says", () => {
    expect(providerOf("@expo/ui", { author: ann })).toBe("expo");
    expect(providerOf("@react-native/js-polyfills", {})).toBe("react-native");
  });

  it("is the author without a scope, then the first maintainer", () => {
    expect(providerOf("zod", { author: ann, maintainers: ["Bo"] })).toBe("Ann Example");
    expect(providerOf("zod", { maintainers: ["Bo", "Cy"] })).toBe("Bo");
    expect(providerOf("zod", { author: { email: "a@example.invalid" }, maintainers: [ann] })).toBe(
      "Ann Example",
    );
  });

  it.each([
    ["a name alone", "Ann Example", "Ann Example"],
    ["a name and an address", "Ann Example <ann@example.invalid>", "Ann Example"],
    ["a name and a home page", "Ann Example (https://example.invalid)", "Ann Example"],
    [
      "a name, an address and a home page",
      "Ann Example <ann@example.invalid> (https://example.invalid)",
      "Ann Example",
    ],
    ["the spaces around a name", "  Ann Example  ", "Ann Example"],
    ["a name outside ASCII", "Jan Mühlemann <jan@example.invalid>", "Jan Mühlemann"],
    ["an object's name, the same way", { name: "Ann <ann@example.invalid>" }, "Ann"],
  ])("reads %s, never the address", (_what, author, provider) => {
    expect(providerOf("zod", { author })).toBe(provider);
  });

  it.each([
    ["nothing", {}],
    ["an empty author", { author: "" }],
    ["an author of spaces", { author: "   " }],
    ["an address with no name", { author: "<ann@example.invalid>" }],
    ["an author of another type", { author: 7 }],
    ["an object with no name", { author: { email: "ann@example.invalid" } }],
    ["a null author", { author: null }],
    ["an empty list of maintainers", { maintainers: [] }],
    ["maintainers that are no list", { maintainers: "Bo" }],
  ])("is nobody for %s", (_what, manifest) => {
    expect(providerOf("zod", manifest)).toBeNull();
  });

  it("gives the start of any author's string, up to its address, or nobody", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc
            .tuple(fc.string(), fc.string())
            .map(([name, rest]) => `${name} <${rest}@example.invalid> (https://${rest})`),
        ),
        (author) => {
          const provider = providerOf("zod", { author });
          if (provider === null) return;
          expect(provider).not.toMatch(/[<(]/);
          expect(provider).toBe(provider.trim());
          expect(author.trimStart().startsWith(provider)).toBe(true);
        },
      ),
      { seed: 512 },
    );
  });

  it("takes no scope from a name that has none whole", () => {
    expect(providerOf("@", {})).toBeNull();
    expect(providerOf("@scope", {})).toBeNull();
    expect(providerOf("/@scope/name", {})).toBeNull();
  });
});

describe("the packages a bundle's source maps name (#177)", () => {
  it("is the directory after the last node_modules, from the workspace root, each once", () => {
    expect(
      shippedPackageDirs(
        [
          "/node_modules/react/index.js",
          "/node_modules/react/cjs/react.production.js",
          "/node_modules/@react-native/js-polyfills/console.js",
          "/apps/mobile/node_modules/expo/src/Expo.ts",
          "/node_modules/react-native/node_modules/scheduler/index.js",
          "/repo/node_modules/@formatjs/intl-locale/index.js",
        ],
        "/repo",
      ),
    ).toEqual([
      "/repo/apps/mobile/node_modules/expo",
      "/repo/node_modules/@formatjs/intl-locale",
      "/repo/node_modules/@react-native/js-polyfills",
      "/repo/node_modules/react",
      "/repo/node_modules/react-native/node_modules/scheduler",
    ]);
  });

  it("leaves out virtual modules, a query's own path, our own files, a relative path and a path with no file in a package", () => {
    expect(
      shippedPackageDirs(
        [
          "__prelude__",
          "__debugid__",
          "\0polyfill:external-require",
          "/apps/mobile/app?ctx=3ab07f305c4346b25020dd398f4d6d4dc9229acb",
          "/apps/mobile/src/features/profile/index.ts",
          "/packages/schema/src/index.ts",
          "../node_modules/hono/dist/index.js",
          "/apps/node_modules",
          "/node_modules/@scope",
          "/node_modules/@scope/name",
          "/node_modules/react",
          "",
        ],
        "/repo",
      ),
    ).toEqual([]);
  });

  it("reads a query off a file too", () => {
    expect(shippedPackageDirs(["/node_modules/a/index.js?ctx=1"], "/repo")).toEqual([
      "/repo/node_modules/a",
    ]);
  });
});

describe("a text as its file has it", () => {
  it("drops a byte-order mark, Windows and old Mac line ends, spaces at line ends and blank lines at either end", () => {
    expect(normaliseText("﻿\n\r\nMIT  \r\n\r\n  body\t\rend \n\n")).toBe("MIT\n\n  body\nend");
  });

  it("leaves a clean text as it is, and an empty one empty", () => {
    expect(normaliseText("a\n\n  b")).toBe("a\n\n  b");
    expect(normaliseText(" \n \n")).toBe("");
  });
});

describe("the paragraphs of a text", () => {
  it("are the runs of lines between blank ones, a line of spaces blank too, none empty", () => {
    expect(blocksOf("\n\na\nb\n\n \t \n\nc\n  d\n\n")).toEqual(["a\nb", "c\n  d"]);
    expect(blocksOf("one")).toEqual(["one"]);
    expect(blocksOf("")).toEqual([]);
    expect(blocksOf("\n \n")).toEqual([]);
  });

  it("are read as the old split on blank lines read them", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "b c", "", " ", "\t", "  d"), { maxLength: 12 }),
        (lines) => {
          const text = lines.join("\n");
          const old = text.split(/\n\s*\n/).map((b) =>
            b
              .split("\n")
              .filter((l) => l.trim() !== "")
              .join("\n"),
          );
          expect(blocksOf(text)).toEqual(old.filter(Boolean));
        },
      ),
    );
  });
});

describe("a text of many newlines (CodeQL js/polynomial-redos)", () => {
  // A hundred thousand newlines before a word: each step is linear, so this runs at once.
  const many = `${"\n".repeat(100_000)}x${"\n".repeat(100_000)}`;

  it("is normalised, split and keyed as any other", () => {
    expect(normaliseText(many)).toBe("x");
    expect(splitNotice(`Copyright X${many}`)).toEqual({ copyright: ["Copyright X"], body: "x" });
    expect(blocksOf(many)).toEqual(["x"]);
    expect(textKey(many)).toBe(textKey("x"));
  });
});

describe("the licence and notice files of a package", () => {
  it("are LICENSE*, LICENCE*, COPYING* and NOTICE* in any case, in name order, nothing else, no code or data", () => {
    const dir = pkg(
      "files/many",
      { name: "many" },
      {
        LICENSE_FONT: "font",
        "LICENSE.md": "code",
        "licence-mit": "mit",
        COPYING: "gpl",
        "notice.txt": "notice",
        NOTICE: "NOTICE",
        "README.md": "readme",
        "license-checker.json": "{}",
        "licenses.js": "module.exports = {}",
      },
    );
    mkdirSync(join(dir, "licenses"));
    const { licences, notices } = shippedFilesOf(dir);
    expect(licences.map((f) => f.file)).toEqual([
      "COPYING",
      "LICENSE.md",
      "LICENSE_FONT",
      "licence-mit",
    ]);
    expect(notices).toEqual([
      { file: "NOTICE", text: "NOTICE" },
      { file: "notice.txt", text: "notice" },
    ]);
  });

  it("drops a file that is empty or only blank, and reads each text normalised", () => {
    const dir = pkg("files/blank", { name: "blank" }, { LICENSE: " \r\n", NOTICE: "a \r\nb\r\n" });
    expect(shippedFilesOf(dir)).toEqual({
      licences: [],
      notices: [{ file: "NOTICE", text: "a\nb" }],
    });
  });
});

describe("a licence file as its copyright lines and body", () => {
  it("splits a title, the copyright line and the body", () => {
    expect(splitNotice(`MIT License\n\nCopyright (c) 2023 FormatJS\n\n${MIT_BODY}`)).toEqual({
      copyright: ["Copyright (c) 2023 FormatJS"],
      body: MIT_BODY,
    });
  });

  it("takes several copyright lines, blank lines between them, (c) and © forms, and no title", () => {
    expect(
      splitNotice(
        `Copyright (c) Phil Pluckthun,\nCopyright (c) 650 Industries, Inc. (aka Expo),\n\n(c) 2015 Someone\n© 2016 Else\n\n${ISC_BODY}`,
      ),
    ).toEqual({
      copyright: [
        "Copyright (c) Phil Pluckthun,",
        "Copyright (c) 650 Industries, Inc. (aka Expo),",
        "(c) 2015 Someone",
        "© 2016 Else",
      ],
      body: ISC_BODY,
    });
  });

  it("takes an All rights reserved under the copyright lines as one of them, never on its own", () => {
    expect(
      splitNotice(
        `Copyright (c) Matteo Collina\nCopyright (c) The Fastify Team\nAll rights reserved.\n\n${ISC_BODY}`,
      ),
    ).toEqual({
      copyright: [
        "Copyright (c) Matteo Collina",
        "Copyright (c) The Fastify Team",
        "All rights reserved.",
      ],
      body: ISC_BODY,
    });
    expect(splitNotice(`All rights reserved.\nCopyright X\n\n${ISC_BODY}`)).toBeNull();
  });

  it("reads the titles licence files carry", () => {
    for (const title of [
      "MIT License",
      "The MIT License (MIT)",
      "ISC License",
      "The ISC License",
      "BSD 3-Clause License",
      "new bsd licence",
    ]) {
      expect(
        splitNotice(`${title}\nCopyright 2017 Andrey Sitnik\n\n${ISC_BODY}`)?.copyright,
      ).toEqual(["Copyright 2017 Andrey Sitnik"]);
    }
  });

  it("keeps a body's own indentation and a second notice inside it", () => {
    const second = `\n\n---\n\nThe MIT License (MIT) (for the icons listed above)\n\nCopyright (c) 2013-present Cole Bemis\n\n${MIT_BODY}`;
    expect(
      splitNotice(`ISC License\n\nCopyright (c) 2026 Lucide\n\n  ${ISC_BODY}${second}`),
    ).toEqual({
      copyright: ["Copyright (c) 2026 Lucide"],
      body: `  ${ISC_BODY}${second}`,
    });
  });

  it("starts the body at a title that follows the copyright lines", () => {
    expect(splitNotice(`Copyright 2020 X\nMIT License\n${MIT_BODY}`)?.body).toBe(
      `MIT License\n${MIT_BODY}`,
    );
  });

  it("is null for a file of another shape, which is kept whole", () => {
    expect(splitNotice(APACHE)).toBeNull();
    expect(
      splitNotice(`Licensed under the terms of the New BSD license.\n\nCopyright 2023 Oath`),
    ).toBeNull();
    expect(splitNotice("MIT License\nThe MIT License\nCopyright 2020 X\n\nbody")).toBeNull();
    expect(splitNotice("Copyright 2020 X\n\n")).toBeNull();
    expect(splitNotice("MIT License")).toBeNull();
    expect(splitNotice("")).toBeNull();
  });

  it("loses no word but the title's, and keeps their order", () => {
    const line = fc
      .string({ minLength: 1, maxLength: 40 })
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => s !== "");
    const bodyLine = line.filter(
      (s) => !/^(copyright|\(c\) |©)/i.test(s) && !/licen[cs]e/i.test(s),
    );
    fc.assert(
      fc.property(
        fc.constantFrom("", "MIT License\n\n", "The ISC License\n"),
        fc.array(
          line.map((s) => `Copyright ${s}`),
          { minLength: 1, maxLength: 4 },
        ),
        fc.array(bodyLine, { minLength: 1, maxLength: 6 }),
        (title, copyright, body) => {
          const text = `${title}${copyright.join("\n")}\n\n${body.join("\n")}`;
          const split = splitNotice(text);
          expect(split?.copyright).toEqual(copyright);
          expect(words(`${split?.copyright.join(" ")} ${split?.body}`)).toBe(
            words(text.slice(title.length)),
          );
        },
      ),
    );
  });
});

describe("the key of a shared text", () => {
  it("is the same for the same paragraphs wrapped at another width, and twelve hex digits", () => {
    const narrow = textKey(MIT_BODY);
    expect(narrow).toMatch(/^[0-9a-f]{12}$/);
    expect(textKey(`  ${MIT_BODY.replace(/(?<!\n)\n(?!\n)/g, " ")}\n\n \n`)).toBe(narrow);
  });

  it("differs for the same words paragraphed otherwise", () => {
    expect(textKey(MIT_BODY.replace(/\n\n/g, "\n"))).not.toBe(textKey(MIT_BODY));
  });

  it("differs for other words, curly quotes included", () => {
    expect(textKey(MIT_BODY.replace(/"Software"/, "“Software”"))).not.toBe(textKey(MIT_BODY));
    expect(textKey(ISC_BODY)).not.toBe(textKey(MIT_BODY));
  });
});

describe("the notices of a bundle's packages (#416)", () => {
  it("keeps a body once for every package that shares it, each with its own copyright lines", () => {
    // The same paragraphs wrapped otherwise; the first package in order gives the text kept.
    const unwrapped = MIT_BODY.replace(/(?<!\n)\n(?!\n)/g, " ");
    const dirs = [
      pkg(
        "a/node_modules/zeta",
        { name: "zeta", version: "1.0.0", license: "MIT", author: "Zed <zed@example.invalid>" },
        {
          LICENSE: `MIT License\n\nCopyright (c) 2019 Zeta\n\n${MIT_BODY}`,
        },
      ),
      pkg(
        "a/node_modules/alpha",
        { name: "alpha", version: "2.0.0", license: "MIT" },
        {
          license: `The MIT License (MIT)\nCopyright (c) Alpha\n\n${unwrapped}`,
        },
      ),
    ];
    const notices = collectNotices(dirs);
    const key = textKey(MIT_BODY);
    expect(notices).toEqual({
      texts: { [key]: unwrapped },
      packages: [
        {
          name: "alpha",
          version: "2.0.0",
          license: "MIT",
          provider: null,
          licences: [{ file: "license", copyright: ["Copyright (c) Alpha"], text: key }],
          notices: [],
        },
        {
          name: "zeta",
          version: "1.0.0",
          license: "MIT",
          provider: "Zed",
          licences: [{ file: "LICENSE", copyright: ["Copyright (c) 2019 Zeta"], text: key }],
          notices: [],
        },
      ],
    });
  });

  it("keeps a file of another shape whole, every licence file of a package, and its NOTICE", () => {
    const dir = pkg(
      "b/node_modules/fonts",
      { name: "fonts", version: "0.4.47", license: "MIT AND Apache-2.0" },
      {
        LICENSE: `MIT License\n\nCopyright (c) 2020 Expo\n\n${MIT_BODY}`,
        LICENSE_FONT: APACHE,
        NOTICE: "Material Symbols\nCopyright 2022 Google LLC",
      },
    );
    const notices = collectNotices([dir]);
    expect(notices.packages[0]?.licences).toEqual([
      { file: "LICENSE", copyright: ["Copyright (c) 2020 Expo"], text: textKey(MIT_BODY) },
      { file: "LICENSE_FONT", copyright: [], text: textKey(APACHE) },
    ]);
    expect(notices.packages[0]?.notices).toEqual([
      textKey("Material Symbols\nCopyright 2022 Google LLC"),
    ]);
    expect(Object.keys(notices.texts)).toHaveLength(3);
    // The keys in order, so the generated file comes out the same every run.
    expect(Object.keys(notices.texts)).toEqual([...Object.keys(notices.texts)].sort());
  });

  it("names a package once however many copies are bundled, a second version on a line of its own", () => {
    const license = { LICENSE: `Copyright 2020 Dup\n\n${ISC_BODY}` };
    const dirs = [
      pkg(
        "c/node_modules/b/node_modules/dup",
        { name: "dup", version: "1.0.0", license: "ISC" },
        license,
      ),
      pkg(
        "c/node_modules/a/node_modules/dup",
        { name: "dup", version: "1.0.0", license: "ISC" },
        {
          LICENSE: `Copyright 2020 First copy\n\n${ISC_BODY}`,
        },
      ),
      pkg("c/node_modules/dup", { name: "dup", version: "1.1.0", license: "ISC" }, license),
      pkg(
        "c/node_modules/nameless",
        { license: "0BSD" },
        { LICENSE: "Copyright Nobody\n\nAnything." },
      ),
    ];
    const packages = collectNotices(dirs).packages;
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual([
      "dup@1.0.0",
      "dup@1.1.0",
      "nameless@?",
    ]);
    // The first directory in path order is the one read.
    expect(packages[0]?.licences[0]?.copyright).toEqual(["Copyright 2020 First copy"]);
  });

  it("gives a package with no licence file its upstream rows, each with the text the package it names ships", () => {
    const curly = MIT_BODY.replace(/"Software"/, "“Software”");
    const dirs = [
      pkg(
        "d/node_modules/expo",
        { name: "expo", version: "1.0.0", license: "MIT" },
        { LICENSE: `Copyright Expo\n\n${MIT_BODY}` },
      ),
      pkg(
        "d/node_modules/odd",
        { name: "odd", version: "1.0.0", license: "MIT" },
        { LICENSE: `Copyright Odd\n\n${curly}` },
      ),
      pkg("d/node_modules/@scope/bare", { name: "@scope/bare", version: "0.1.0", license: "MIT" }),
    ];
    const expo = {
      copyright: ["Copyright (c) 2015-present 650 Industries, Inc. (aka Expo)"],
      like: "expo",
      from: "https://github.com/expo/expo/blob/sdk-57/LICENSE",
    };
    const navigation = {
      copyright: ["Copyright (c) 2017 React Navigation Contributors"],
      like: "odd",
      from: "https://github.com/expo/expo/blob/sdk-57/packages/expo-router/src/react-navigation/LICENCE",
    };
    expect(collectNotices(dirs, { "@scope/bare": [expo, navigation] }).packages[0]).toEqual({
      name: "@scope/bare",
      version: "0.1.0",
      license: "MIT",
      provider: "scope",
      licences: [
        { file: null, copyright: expo.copyright, text: textKey(MIT_BODY), from: expo.from },
        {
          file: null,
          copyright: navigation.copyright,
          text: textKey(curly),
          from: navigation.from,
        },
      ],
      notices: [],
    });
  });

  it("gives a package a file deeper in it, whole, for the code it vendored", () => {
    const vendored =
      "Name: debug\nLicense: MIT\n\nCopyright (c) 2014 TJ Holowaychuk\n\nNotice:\nOrchestrion-JS";
    const dir = pkg("j/node_modules/injection", {
      name: "injection",
      version: "11.5.0",
      license: "MIT",
    });
    mkdirSync(join(dir, "build"));
    writeFileSync(join(dir, "build", "THIRD-PARTY-LICENSES.txt"), `${vendored}\r\n`);
    const own = pkg(
      "j/node_modules/core",
      { name: "core", version: "11.5.0", license: "MIT" },
      {
        LICENSE: `Copyright Sentry\n\n${MIT_BODY}`,
      },
    );
    const notices = collectNotices([dir, own], {
      injection: [
        {
          copyright: ["Copyright (c) 2012 Sentry"],
          like: "core",
          from: "https://example.invalid/LICENSE",
        },
        { file: "build/THIRD-PARTY-LICENSES.txt" },
      ],
    });
    expect(notices.packages[1]?.licences).toEqual([
      {
        file: null,
        copyright: ["Copyright (c) 2012 Sentry"],
        text: textKey(MIT_BODY),
        from: "https://example.invalid/LICENSE",
      },
      { file: "build/THIRD-PARTY-LICENSES.txt", copyright: [], text: textKey(vendored) },
    ]);
    expect(notices.texts[textKey(vendored)]).toBe(vendored);
  });

  it("keeps the NOTICE of a package that takes its licence from the table", () => {
    const notice = "Smithy Typescript\nCopyright 2019 Amazon.com, Inc. or its affiliates.";
    const dirs = [
      pkg(
        "l/node_modules/core",
        { name: "core", version: "1.0.0", license: "Apache-2.0" },
        { LICENSE: APACHE },
      ),
      pkg(
        "l/node_modules/bare",
        { name: "bare", version: "1.0.0", license: "Apache-2.0" },
        { NOTICE: notice },
      ),
    ];
    const notices = collectNotices(dirs, {
      bare: [{ copyright: [], like: "core", from: "https://example.invalid/LICENSE" }],
    });
    expect(notices.packages.find((p) => p.name === "bare")?.notices).toEqual([textKey(notice)]);
    expect(notices.texts[textKey(notice)]).toBe(notice);
  });

  it("refuses a file row the package does not have", () => {
    const dirs = [pkg("k/node_modules/bare", { name: "bare", version: "1.0.0", license: "MIT" })];
    expect(() => collectNotices(dirs, { bare: [{ file: "build/NONE.txt" }] })).toThrow(
      "bare@1.0.0 has no build/NONE.txt, which its row names",
    );
  });

  it("refuses a package with no licence file and no row, naming it, an empty row and a prototype's name too", () => {
    const dirs = [
      pkg("f/node_modules/bare", { name: "bare", version: "3.1.4", license: "MIT" }),
      pkg("f/node_modules/constructor", { name: "constructor", version: "1.0.0", license: "MIT" }),
      pkg("f/node_modules/empty", { name: "empty", version: "1.0.0", license: "MIT" }),
    ];
    expect(() => collectNotices(dirs, { empty: [] })).toThrow(
      "no licence text for bare@3.1.4, constructor@1.0.0, empty@1.0.0: the package ships no licence file and the table of upstream licences has no row for it",
    );
  });

  it("refuses a row that no package needs, so the table never outlives its reason", () => {
    const dirs = [
      pkg(
        "g/node_modules/own",
        { name: "own", version: "1.0.0", license: "MIT" },
        { LICENSE: `Copyright Own\n\n${MIT_BODY}` },
      ),
    ];
    const row = [{ copyright: ["Copyright Own"], like: "own", from: "https://example.invalid" }];
    expect(() => collectNotices(dirs, { own: row, gone: row })).toThrow(
      "the table of upstream licences has a row nothing needs: own, gone ships its own licence file now, or no longer ships",
    );
  });

  it("refuses a row whose text cannot be had: a package that does not ship, carries two licences or another licence", () => {
    const dirs = [
      pkg("h/node_modules/bare", { name: "bare", version: "1.0.0", license: "Apache-2.0" }),
      pkg(
        "h/node_modules/mit",
        { name: "mit", version: "1.0.0", license: "MIT" },
        { LICENSE: `Copyright M\n\n${MIT_BODY}` },
      ),
      pkg(
        "h/node_modules/two",
        { name: "two", version: "1.0.0", license: "Apache-2.0" },
        {
          LICENSE: `Copyright T\n\n${MIT_BODY}`,
          LICENSE_FONT: APACHE,
        },
      ),
    ];
    const row = (like: string) => ({
      bare: [{ copyright: ["Copyright Bare"], like, from: "https://example.invalid" }],
    });
    expect(() => collectNotices(dirs, row("mit"))).toThrow(
      "bare@1.0.0 takes its Apache-2.0 text from mit, which is under MIT: pick another package for its row",
    );
    expect(() => collectNotices(dirs, row("two"))).toThrow(
      "bare@1.0.0 takes its Apache-2.0 text from two, which carries 2 licence files: pick another package for its row",
    );
    expect(() => collectNotices(dirs, row("gone"))).toThrow(
      "bare@1.0.0 takes its Apache-2.0 text from gone, which this bundle does not carry: pick another package for its row",
    );
    // One that ships with no licence file of its own, and so takes a row itself.
    const withBare = [
      ...dirs,
      pkg("h/node_modules/bare-too", { name: "bare-too", version: "1.0.0", license: "Apache-2.0" }),
    ];
    expect(() =>
      collectNotices(withBare, {
        ...row("bare-too"),
        "bare-too": [{ copyright: ["Copyright B"], like: "two", from: "https://example.invalid" }],
      }),
    ).toThrow(
      "bare@1.0.0 takes its Apache-2.0 text from bare-too, which ships no licence file of its own: pick another package for its row",
    );
  });

  it("is empty for no directories", () => {
    expect(collectNotices([])).toEqual({ texts: {}, packages: [] });
  });
});
