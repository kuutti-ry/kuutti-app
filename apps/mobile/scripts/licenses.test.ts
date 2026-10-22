import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  installedPackages,
  type LicenceList,
  licenceList,
  OUTPUT,
  paragraphs,
  UPSTREAM,
} from "./licenses";

// What the bundles are made of and how a licence file reads are
// @kuutti/notices' own tests; these are the app's part: the paragraphs the
// screen shows, the table of upstream licences, and the committed list.

const words = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");
/** A licence file's title line, the one line the split drops ("MIT License", "The MIT License (MIT)"). */
const TITLE = /^(the )?[\w.-]+( [\w.-]+)? licen[cs]e( \([\w.-]+\))?$/i;

describe("a licence text as the screen's paragraphs (#416)", () => {
  it("joins the lines a file wrapped at eighty columns, one string per paragraph, the indentation gone", () => {
    expect(
      paragraphs(
        "Permission is hereby granted, free of charge, to any person obtaining a copy\n    of this software.\n\n\n  The above copyright notice and this permission notice shall be included in all\ncopies.",
      ),
    ).toEqual([
      "Permission is hereby granted, free of charge, to any person obtaining a copy of this software.",
      "The above copyright notice and this permission notice shall be included in all copies.",
    ]);
  });

  it("keeps the break before a list item, whatever marks it", () => {
    expect(
      paragraphs(
        "Redistribution is permitted provided that the following conditions are met:\n- Redistributions of source code must retain the above\n  copyright notice.\n* binary form\n2. Neither the name\n(a) You must give\n(iv) and the rest",
      ),
    ).toEqual([
      "Redistribution is permitted provided that the following conditions are met:\n- Redistributions of source code must retain the above copyright notice.\n* binary form\n2. Neither the name\n(a) You must give\n(iv) and the rest",
    ]);
  });

  it("keeps the lines of a block of short lines, which the file broke on purpose", () => {
    expect(
      paragraphs(
        "                                 Apache License\n                           Version 2.0, January 2004\n                        http://www.apache.org/licenses/",
      ),
    ).toEqual(["Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/"]);
  });

  it("is nothing for a text of blank lines", () => {
    expect(paragraphs("")).toEqual([]);
    expect(paragraphs(" \n\n \n")).toEqual([]);
  });

  it("keeps the packages as they are and turns each text into its paragraphs", () => {
    const pkg = {
      name: "a",
      version: "1.0.0",
      license: "MIT",
      licences: [{ file: "LICENSE", copyright: ["Copyright A"], text: "k1" }],
      notices: [],
    };
    const wrapped = "A line long enough to be one the file wrapped,\nand its end.";
    expect(licenceList({ packages: [pkg], texts: { k1: `${wrapped}\n\nthree` } })).toEqual({
      packages: [pkg],
      texts: { k1: ["A line long enough to be one the file wrapped, and its end.", "three"] },
    });
  });
});

describe("the packages installed for the app", () => {
  const names = new Set(installedPackages().map((e) => e.name));

  it("follows our workspace packages' dependencies without listing the packages themselves", () => {
    expect(names.has("zod")).toBe(true);
    expect([...names].filter((n) => n.startsWith("@kuutti/"))).toEqual([]);
  });

  it("leaves out optional dependencies, the installing machine's and not the app's", () => {
    expect([...names].filter((n) => n === "fsevents" || n.startsWith("@sentry/cli-"))).toEqual([]);
  });
});

describe("src/generated/licenses.json (#143, #177, #416)", () => {
  const committed: LicenceList = JSON.parse(readFileSync(OUTPUT, "utf8"));
  const byName = (name: string) => committed.packages.find((p) => p.name === name);
  const textOf = (key: string) => (committed.texts[key] ?? []).join("\n\n");

  it("names the packages the app is made of, each with a licence, none of them ours", () => {
    const names = new Set(committed.packages.map((e) => e.name));
    const missing = ["expo", "react-native", "react", "expo-router", "zod", "i18next"].filter(
      (n) => !names.has(n),
    );
    expect(missing).toEqual([]);
    expect(committed.packages.filter((e) => !e.license || e.license === "unknown")).toEqual([]);
    expect(committed.packages.filter((e) => e.name.startsWith("@kuutti/"))).toEqual([]);
  });

  it("leaves out what never reaches a phone: the web target, a config plugin, the build tooling", () => {
    const names = new Set(committed.packages.map((e) => e.name));
    expect(
      ["react-native-web", "react-dom", "expo-build-properties", "@babel/core"].filter((n) =>
        names.has(n),
      ),
    ).toEqual([]);
  });

  it("is a part of what is installed, at the installed versions; stale? pnpm --filter mobile run licenses", () => {
    const installed = new Set(
      installedPackages().map((e) => `${e.name}@${e.version} ${e.license}`),
    );
    expect(
      committed.packages.filter((e) => !installed.has(`${e.name}@${e.version} ${e.license}`)),
    ).toEqual([]);
  });

  it("gives every package a licence with a text, and names no text it does not carry", () => {
    const named = committed.packages.flatMap((p) => [
      ...p.licences.map((l) => l.text),
      ...p.notices,
    ]);
    expect(committed.packages.filter((p) => p.licences.length === 0)).toEqual([]);
    expect(named.filter((key) => !committed.texts[key]?.length)).toEqual([]);
    expect(Object.keys(committed.texts).filter((key) => !named.includes(key))).toEqual([]);
  });

  it("starts every copyright line as a copyright line, and keeps a split file's lines out of its text", () => {
    const lines = committed.packages.flatMap((p) => p.licences.flatMap((l) => l.copyright));
    expect(lines.filter((line) => !/^(copyright\b|\(c\) |©)/i.test(line))).toEqual([]);
    for (const p of committed.packages) {
      for (const l of p.licences) {
        for (const line of l.copyright) expect(textOf(l.text)).not.toContain(line);
      }
    }
  });

  it("carries the upstream rows of the packages with no licence file, and only theirs", () => {
    const upstream = committed.packages
      .filter((p) => p.licences.some((l) => l.file === null))
      .map((p) => p.name)
      .sort();
    expect(upstream).toEqual(Object.keys(UPSTREAM).sort());
    for (const [name, rows] of Object.entries(UPSTREAM)) {
      expect(byName(name)?.licences.map(({ copyright, from }) => ({ copyright, from }))).toEqual(
        rows.map((row) => ("file" in row ? row : { copyright: row.copyright, from: row.from })),
      );
    }
    const mit = byName("react")?.licences[0]?.text;
    expect(
      Object.keys(UPSTREAM).flatMap((name) => byName(name)?.licences.map((l) => l.text) ?? []),
    ).toEqual(expect.arrayContaining([mit]));
    expect(
      new Set(
        Object.keys(UPSTREAM).flatMap((name) => byName(name)?.licences.map((l) => l.text) ?? []),
      ),
    ).toEqual(new Set([mit]));
  });

  it("keeps Lucide's Feather notice beside the icons it covers, as Lucide's file has it", () => {
    const lucide = byName("lucide-react-native");
    expect(lucide?.licences).toHaveLength(1);
    const text = textOf(lucide?.licences[0]?.text ?? "");
    expect(text).toContain("The following Lucide icons are derived from the Feather project:");
    expect(text).toMatch(/arrow-left, .*more-horizontal, .*x-square, x, zoom-in, zoom-out/);
    expect(text).toContain("Copyright (c) 2013-present Cole Bemis");
    expect(text.indexOf("Feather project")).toBeLessThan(text.indexOf("Cole Bemis"));
  });

  it("carries both of Material Symbols' files, the font's Apache-2.0 text whole", () => {
    const symbols = byName("@expo-google-fonts/material-symbols");
    expect(symbols?.licences.map((l) => [l.file, l.copyright])).toEqual([
      ["LICENSE", ["Copyright (c) 2020 Expo"]],
      ["LICENSE_FONT", []],
    ]);
    const font = committed.texts[symbols?.licences[1]?.text ?? ""] ?? [];
    expect(font[0]).toBe(
      "Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/",
    );
    expect(font).toContain("END OF TERMS AND CONDITIONS");
    expect(font.at(-1)).toMatch(/limitations under the License\.$/);
  });

  it("is each package's own file, word for word, but the title line, where the install has the same version", () => {
    // The copy at the top of the app's or the workspace's node_modules; a
    // package installed twice may be another copy there, so a version that
    // differs is not compared. The export in CI compares every one.
    const app = join(OUTPUT, "..", "..", "..");
    const dirOf = (name: string, version: string) =>
      [join(app, "node_modules", name), join(app, "..", "..", "node_modules", name)].find(
        (dir) =>
          existsSync(join(dir, "package.json")) &&
          JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version === version,
      );
    let compared = 0;
    for (const p of committed.packages) {
      const dir = dirOf(p.name, p.version);
      for (const l of p.licences) {
        if (!dir || l.file === null) continue;
        const file = words(readFileSync(join(dir, l.file), "utf8"));
        const ours = words([...l.copyright, textOf(l.text)].join(" "));
        // All the file's words are ours but, at most, one title line before them.
        const dropped = file.slice(0, file.length - ours.length).trim();
        const kept = file.endsWith(ours) && (dropped === "" || TITLE.test(dropped));
        expect([p.name, l.file, dropped, kept]).toEqual([p.name, l.file, dropped, true]);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(90);
  });
});
