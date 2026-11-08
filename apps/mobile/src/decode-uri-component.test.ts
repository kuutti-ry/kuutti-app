import { readFileSync } from "node:fs";

// GHSA-qr28-fpjm-wq7f: decode-uri-component 0.2.2 decodes a string of many
// distinct percent-encoded runs in quadratic time, replacing each run's text
// throughout the string once per run. It ships in the app's bundle under
// query-string 7, which asks for ^0.2.2; no link reaches it today (expo-router
// reads a link's query with URL, and builds paths with query-string, which
// encodes), but the React Navigation code it bundles would parse a query with
// it. The one fixed release, 0.5.1, is an ES module, whose namespace
// query-string 7's require() cannot call, so 0.5.1's decoder is patched onto
// 0.2.2 (patches/decode-uri-component@0.2.2.patch), and the audit, which reads
// the version alone, sets the advisory aside (pnpm-workspace.yaml). This holds
// the installed copy to the fix. The cases are those of the package's own tests
// at 0.2.2 and at 0.5.1 (MIT, Sam Verschueren), the answers 0.5.1's with `+`
// read as a space, as 0.2.2 reads it. Remove this file with the patch.
const decode = require("decode-uri-component") as (encoded: unknown) => string;

/** 0.2.2's own cases, answered as 0.2.2 answers them. */
const OWN: ReadonlyArray<readonly [string, string]> = [
  ["test", "test"],
  ["a+b", "a b"],
  ["a+b+c+d", "a b c d"],
  ["=a", "=a"],
  ["%", "%"],
  ["%25", "%"],
  ["%%25%%", "%%%%"],
  ["st%C3%A5le", "ståle"],
  ["st%C3%A5le%", "ståle%"],
  ["%st%C3%A5le%", "%ståle%"],
  ["%%7Bst%C3%A5le%7D%", "%{ståle}%"],
  ["%ab%C3%A5le%", "%abåle%"],
  ["%C3%A5%able%", "å%able%"],
  ["%7B%ab%7C%de%7D", "{%ab|%de}"],
  ["%7B%ab%%7C%de%%7D", "{%ab%|%de%}"],
  ["%7 B%ab%%7C%de%%7 D", "%7 B%ab%|%de%%7 D"],
  ["%ab", "%ab"],
  ["%ab%ab%ab", "%ab%ab%ab"],
  ["%61+%4d%4D", "a MM"],
  ["\ufefftest", "\ufefftest"],
  ["\ufeff", "\ufeff"],
  ["%EF%BB%BFtest", "\ufefftest"],
  ["%EF%BB%BF", "\ufeff"],
  ["%FE%FF", "\ufffd\ufffd"],
  ["%FF%FE", "\ufffd\ufffd"],
  ["†", "†"],
  ["%C2", "\ufffd"],
  ["%C2x", "\ufffdx"],
  ["%C2%B5", "µ"],
  ["%C2%B5%", "µ%"],
  ["%%C2%B5%", "%µ%"],
  ["%ea%ba%5a%ba", "%ea%baZ%ba"],
  ["%C3%5A%A5", "%C3Z%A5"],
  ["%C3%5A%A5%AB", "%C3Z%A5%AB"],
];

/** 0.5.1's further cases, answered as 0.5.1 answers them. */
const FIXED: ReadonlyArray<readonly [string, string]> = [
  ["", ""],
  ["%20", " "],
  ["%2B", "+"],
  ["%2b", "+"],
  ["%00", "\u0000"],
  ["%7F", "\u007f"],
  ["%09", "\t"],
  ["%0A", "\n"],
  ["%0D%0A", "\r\n"],
  ["%61%62%63", "abc"],
  ["%2F%3F%23", "/?#"],
  ["%7E", "~"],
  ["%E2%80%A0", "†"],
  ["%F4%8F%BF%BF", "\udbff\udfff"],
  ["%ED%9F%BF", "퟿"],
  ["%F0%9F%98%80%F0%9F%98%81", "\ud83d\ude00\ud83d\ude01"],
  ["%2525", "%25"],
  ["%E4%BD%A0%E5%A5%BD", "你好"],
  ["%E4%BD%A0%20%E5%A5%BD%21\ufffd\ufffd", "你 好!\ufffd\ufffd"],
  ["%F0%9D%84%9E", "\ud834\udd1e"],
  ["%c3%a5", "å"],
  ["%C3%a5", "å"],
  ["%7b%ab%7c%de%7d", "{%ab|%de}"],
  ["%C2%41", "\ufffdA"],
  ["%C2%C2", "\ufffd\ufffd"],
  ["%C2G5", "\ufffdG5"],
  ["prefix%C2suffix", "prefix\ufffdsuffix"],
  ["%C3%A5%C2", "å\ufffd"],
  ["%C2%B5%C2", "µ\ufffd"],
  ["%C2%C2%B5", "\ufffdµ"],
  ["%%C2%%", "%\ufffd%%"],
  ["%F0%9F%98%80", "\ud83d\ude00"],
  ["%F0%9F%98", "%F0%9F%98"],
  ["%F0%9F", "%F0%9F"],
  ["%F0", "%F0"],
  ["%F0%9F%41", "%F0%9FA"],
  ["%F0%41%82%83", "%F0A%82%83"],
  ["%F5%80%80%80", "%F5%80%80%80"],
  ["%F8%88%88%88", "%F8%88%88%88"],
  ["%C0%AF", "%C0%AF"],
  ["%C1%BF", "%C1%BF"],
  ["%E2%82%AC", "€"],
  ["%E2%82", "%E2%82"],
  ["%E2%41%AC", "%E2A%AC"],
  ["%E0%80%41", "%E0%80A"],
  ["%ED%A0%80", "%ED%A0%80"],
  ["%80", "%80"],
  ["%BF", "%BF"],
  ["%C3", "%C3"],
  ["%DF", "%DF"],
  ["%C3%41", "%C3A"],
  ["%F0%9F%98%80%ab", "\ud83d\ude00%ab"],
  ["%C3%A5%ab", "å%ab"],
  ["%E0%80%80", "%E0%80%80"],
  ["%E0%80%81", "%E0%80%81"],
  ["%F0%80%80%80", "%F0%80%80%80"],
  ["%F0%8F%BF%BF", "%F0%8F%BF%BF"],
  ["%E0%80%80%ab", "%E0%80%80%ab"],
  ["%ED%BF%BF", "%ED%BF%BF"],
  ["%F4%90%80%80", "%F4%90%80%80"],
  ["%G0", "%G0"],
  ["%0G", "%0G"],
  ["%GG", "%GG"],
  ["foo%bar", "foo%bar"],
  ["%u0041", "%u0041"],
  ["%C1%88", "%C1%88"],
  ["%F9%80%80%80", "%F9%80%80%80"],
  ["%FA%80%80%80", "%FA%80%80%80"],
  ["%FB%80%80%80", "%FB%80%80%80"],
  ["%FC%80%80%80", "%FC%80%80%80"],
  ["%FD%80%80%80", "%FD%80%80%80"],
  ["%FE%80%80%80", "%FE%80%80%80"],
  ["%FF%80%80%80", "%FF%80%80%80"],
  ["%FF", "%FF"],
  ["%80%80%80", "%80%80%80"],
  ["%C3%A5%80%C3%A5", "å%80å"],
  ["%G0%C3%A5%ab", "%G0å%ab"],
  ["%F0%9F%98%80%G0", "\ud83d\ude00%G0"],
  ["%C3%A5%%C3%A5", "å%å"],
  ["%ab%cd%ef", "%ab%cd%ef"],
  ["a%FE%FFb", "a\ufffd\ufffdb"],
  ["%FE%FF%FE%FF", "\ufffd\ufffd\ufffd\ufffd"],
  ["%41%FE%FF", "A\ufffd\ufffd"],
  ["%252525", "%2525"],
  ["%25C2%zz", "%C2%zz"],
  ["%25%41%zz", "%A%zz"],
  ["%%%", "%%%"],
  ["%25C2%25", "%C2%"],
  ["%2525C2", "%25C2"],
  ["%84%D7%25%88%90", "%84%D7%%88%90"],
  ["%20%20%25%80", "  %%80"],
];

describe("decode-uri-component, patched for GHSA-qr28-fpjm-wq7f", () => {
  it.each(OWN)("decodes %j as 0.2.2 did: %j", (input, output) => {
    expect(decode(input)).toBe(output);
  });

  it.each(FIXED)("decodes %j as 0.5.1 does: %j", (input, output) => {
    expect(decode(input)).toBe(output);
  });

  it("reads `+` as a space, as 0.2.2 did and query-string 7 expects", () => {
    expect(decode("a+b")).toBe("a b");
    expect(decode("%2B+%zz")).toBe("+ %zz");
  });

  it("refuses anything but a string, in 0.2.2's words", () => {
    expect(() => decode(5)).toThrow("Expected `encodedURI` to be of type `string`, got `number`");
    expect(() => decode(undefined)).toThrow("got `undefined`");
  });

  it("decodes many distinct runs in one pass over the string, not one pass per run", () => {
    let input = "";
    // A thousand is enough to count by; the spy keeps every call's string, which
    // under 0.2.2's one call per run would fill the heap at the advisory's 32,000.
    for (let index = 0; index < 1000; index++) {
      const high = Math.floor(index / 256)
        .toString(16)
        .padStart(2, "0");
      const low = (index % 256).toString(16).padStart(2, "0");
      input += `%${high}%${low}x`;
    }
    input += "%zz";
    const replace = jest.spyOn(String.prototype, "replace");
    try {
      const output = decode(input);
      expect(output.endsWith("x%zz")).toBe(true);
      // `+` as a space, then the runs: 0.2.2 called it once more for every distinct run.
      expect(replace).toHaveBeenCalledTimes(2);
    } finally {
      replace.mockRestore();
    }
  });

  it("is what query-string 7 decodes a query with", () => {
    const { parse } = require("query-string") as {
      parse: (query: string) => Record<string, unknown>;
    };
    expect(parse("a=st%C3%A5le+%zz&b=%25C2%zz")).toEqual({ a: "st\u00e5le %zz", b: "%C2%zz" });
  });

  it("is the patched copy, not 0.2.2's", () => {
    const source = readFileSync(require.resolve("decode-uri-component"), "utf8");
    expect(source).toContain("GHSA-qr28-fpjm-wq7f");
    expect(source).not.toContain("replaceMap");
  });
});
