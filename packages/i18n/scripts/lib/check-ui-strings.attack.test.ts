import { resolve } from "node:path";
import { expect, vi } from "vitest";
import { attack } from "./attack.ts";

// Attacks on `pnpm lint`'s check:ui-strings as a command (#380): what it reads
// of the clients, and the dates it refuses outside this package
// (.claude/rules/i18n.md, the dates bullet; the script's header). The script
// runs in this process over a file system that holds only what a case gives
// it, as commands.test.ts runs it: nothing here reads the repository.

const disk = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const under = (dir: string) =>
    [...disk.files.keys()].filter((path) => path.startsWith(`${dir}/`));
  const fake = {
    ...real,
    readFileSync: (path: unknown) => {
      const text = disk.files.get(String(path));
      if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
      return text;
    },
    readdirSync: (dir: unknown) => {
      const names = under(String(dir)).map((path) => path.slice(String(dir).length + 1));
      if (names.length === 0) throw new Error(`ENOENT: no such directory, scandir '${dir}'`);
      return [...new Set(names.map((name) => name.split("/")[0] as string))].sort();
    },
    statSync: (path: unknown) => ({ isDirectory: () => under(String(path)).length > 0 }),
  };
  return { ...fake, default: fake };
});

const REPO = resolve(import.meta.dirname, "..", "..", "..", "..");

/** Three clean files, one in each folder the check reads, so that every folder exists. */
const CLEAN = {
  "apps/mobile/app/index.tsx": "export const A = () => <Text>{t('home.title')}</Text>;\n",
  "apps/mobile/src/lib/clock.ts": "export const now = () => Date.now();\n",
  "apps/admin/src/App.tsx": "export const App = () => <main>{t('admin.title')}</main>;\n",
};

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/** Runs the check over the clean files and `files`, and says how it ended and what it refused. */
async function lint(files: Record<string, string>): Promise<{ code: number; refused: string[] }> {
  disk.files.clear();
  for (const [path, text] of Object.entries({ ...CLEAN, ...files })) {
    disk.files.set(resolve(REPO, path), text);
  }
  vi.resetModules();
  const refused: string[] = [];
  const spies = [
    vi.spyOn(console, "error").mockImplementation((line: unknown) => void refused.push(`${line}`)),
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Exit(code);
    }) as never),
  ];
  try {
    await import("../check-ui-strings.ts");
    return { code: 0, refused };
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    return { code: error.code ?? 0, refused };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

const passes = (seen: { code: number; refused: string[] }) =>
  expect(seen).toEqual({ code: 0, refused: [] });

const SCREEN = "export const S = () => <Text>Hello</Text>;\n";
const TRANSLATED = "export const S = () => <Text>{t('a.b')}</Text>;\n";

// What goes through today (#380): a hole, which its contract forbids, and a
// question, where no line says what should happen.
const HOLE = "#380";
const QUESTION = "#380, a question";

/** What is tried, where a screen with an inline string is put, and whether it goes through today. */
const PLACES: [string, string, string?][] = [
  [
    "a screen in a route group, a folder with brackets in its name",
    "apps/mobile/app/(tabs)/you.tsx",
  ],
  [
    "a screen whose name only looks like a test's",
    "apps/mobile/src/features/chat/Thread.tests.tsx",
  ],
  // The three folders and the two endings are fixed lists: what is beside them is not opened.
  [
    "a client's screen in a folder beside app and src",
    "apps/mobile/components/Banner.tsx",
    QUESTION,
  ],
  ["a screen written as .jsx", "apps/admin/src/features/safety/Old.jsx", QUESTION],
];

for (const [name, path, open] of PLACES) {
  attack(`check:ui-strings: ${name} is not read`, {
    attempt: () => lint({ [path]: SCREEN }),
    control: () => lint({ [path]: TRANSLATED }),
    succeeds: passes,
    open,
  });
}

const when = (body: string) =>
  `import { formatDate } from "@kuutti/i18n";\nexport const when = (d: Date) => ${body};\n`;

/** What is tried, a date or a time formatted in a client outside the package, and whether it goes through today. */
const DATES: [string, string, string?][] = [
  // The same methods in another spelling: the pass looks for a listed name with
  // a bracket straight after it, for "Intl.DateTimeFormat" and for a bare "dateStyle:".
  ["a time formatted with toTimeString", "d.toTimeString()", HOLE],
  ["a date formatted through an optional call", "d.toLocaleDateString?.()", HOLE],
  ["a date formatted through a method named in brackets", 'd["toLocaleDateString"]()', HOLE],
  [
    "a date formatted by Intl's formatter once it is taken out of Intl",
    '(({ DateTimeFormat }) => new DateTimeFormat("fi").format(d))(Intl)',
    HOLE,
  ],
  ["a date style given under a quoted key", 'show(d, { "dateStyle": "short" })', HOLE],
  // Other means than the ones the check's header names.
  ["an ISO date cut out of toISOString", "d.toISOString().slice(0, 10)", QUESTION],
  [
    "a date put together by hand, month first",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source under test, not a template of this file
    "`${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`",
    QUESTION,
  ],
  // Forms the check has to read like the plain ones.
  ["a date formatted on a line of its own after the value", "d\n    .toLocaleDateString()"],
  ["a date formatted with a space before the call's bracket", "d.toLocaleDateString ()"],
  ["Intl's formatter called without new", 'Intl.DateTimeFormat("fi").format(d)'],
];

for (const [name, body, open] of DATES) {
  attack(`check:ui-strings: ${name} passes`, {
    attempt: () => lint({ "apps/mobile/src/lib/when.ts": when(body) }),
    control: () => lint({ "apps/mobile/src/lib/when.ts": when("formatDate(d)") }),
    succeeds: passes,
    open,
  });
}

// The pass blanks block comments before it looks: two strings that hold a
// comment's marks, as a file picker's "image/*" does, make one of what lies between.
attack(
  "check:ui-strings: a date formatted between two strings that hold a comment's marks passes",
  {
    attempt: () =>
      lint({
        "apps/admin/src/features/media/Pick.tsx": `const kinds = "image/*";\nexport const when = (d: Date) => d.toLocaleDateString();\nconst all = "*/*";\n`,
      }),
    control: () =>
      lint({
        "apps/admin/src/features/media/Pick.tsx": `const kinds = "image/*";\nexport const when = (d: Date) => formatDate(d);\nconst all = "*/*";\n`,
      }),
    succeeds: passes,
    open: HOLE,
  },
);

const refuses = (seen: { code: number; refused: string[] }) => expect(seen.code).toBe(1);

/** What is tried, a line that formats nothing, one that does, in the same place, and whether it goes through today. */
const NOT_A_DATE: [string, string, string, string?][] = [
  // Only a comment that has its line to itself is taken out before the pass looks.
  [
    "a comment after code that names the method",
    "export const n = 1; // never toLocaleDateString() here\n",
    "export const n = (d: Date) => d.toLocaleDateString();\n",
    HOLE,
  ],
  [
    "a key that only starts like dateStyle",
    "export const sheet = { dateStyleSheet: 1 };\n",
    'export const sheet = { dateStyle: "short" };\n',
  ],
  [
    "a method that only ends like toLocaleString",
    "export const n = (x: { mytoLocaleString(): string }) => x.mytoLocaleString();\n",
    "export const n = (x: Date) => x.toLocaleString();\n",
  ],
];

for (const [name, harmless, formatted, open] of NOT_A_DATE) {
  attack(`check:ui-strings: ${name} is refused as a date formatted outside the package`, {
    attempt: () => lint({ "apps/mobile/src/lib/when.ts": harmless }),
    control: () => lint({ "apps/mobile/src/lib/when.ts": formatted }),
    succeeds: refuses,
    open,
  });
}
