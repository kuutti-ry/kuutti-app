import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { ageFromYearMonth, isAdult, parseHetu } from "@kuutti/tunnistus-oidc/hetu";
import { describe, expect, it } from "vitest";
import { renderBankPage } from "./bank-page.ts";
import {
  assertArtificial,
  DEMO_PERSONAS,
  hasFixedIdentity,
  MOCK_BANK_ACR,
  personaBirth,
  personaClaims,
  personaHetu,
} from "./personas.ts";

// The people of the mock bank and its login page (#73, ADR-014).

const DAYS = [
  new Date(Date.UTC(2026, 8, 27, 12)),
  new Date(Date.UTC(2026, 0, 1)), // January: a month ago is December of the year before
  new Date(Date.UTC(2026, 0, 31, 23, 59)),
  new Date(Date.UTC(2028, 1, 29)), // a leap day
  new Date(Date.UTC(2027, 11, 31, 23, 59)),
  new Date(Date.UTC(2099, 11, 1)), // the 99-year-old is born in 2000: her sign turns from - to A
  new Date(Date.UTC(2018, 5, 15)), // the 18-year-olds are born in 2000 and the 17-year-old in 2001
  new Date(Date.UTC(2026, 2, 31)),
];

const persona = (key: string) => {
  const found = DEMO_PERSONAS.find((p) => p.key === key);
  if (!found) throw new Error(`no persona ${key}`);
  return found;
};

describe("the personas of the mock bank", () => {
  it("are twelve, each with a name of its own and an artificial code", () => {
    expect(DEMO_PERSONAS).toHaveLength(12);
    expect(new Set(DEMO_PERSONAS.map((p) => p.key)).size).toBe(12);
    expect(new Set(DEMO_PERSONAS.map((p) => p.individual)).size).toBe(12);
    for (const p of DEMO_PERSONAS) {
      expect(p.key).toMatch(/^[a-z]+$/);
      // 900 to 999: never given to a person.
      expect(p.individual).toBeGreaterThanOrEqual(900);
      expect(p.individual).toBeLessThanOrEqual(999);
    }
  });

  it("carry a code the product's own parser accepts, on every day", () => {
    for (const at of DAYS) {
      for (const p of DEMO_PERSONAS) {
        const parsed = parseHetu(personaHetu(p, at));
        const born = personaBirth(p, at);
        expect(parsed, `${p.key} on ${at.toISOString()}`).toMatchObject({
          birthYear: born.year,
          birthMonth: born.month,
          birthDay: born.day,
          individualNumber: p.individual,
        });
      }
    }
  });

  it("are, when born on a fixed day, the test persons of Telia's pre-production bed (#140)", () => {
    // The published codes of the bed's test users (docs/vendors/telia.md 1.4),
    // character for character: the mock bank issues what the test bank returns.
    const bed: Record<string, string> = {
      aino: "291292-918R",
      mikael: "010170-960F",
      sanna: "170677-924F",
      onni: "010200A9618",
      noa: "030883-925M",
      kerttu: "010280-952L",
      tapio: "070770-905D",
      ilona: "010170-999R",
    };
    for (const [key, code] of Object.entries(bed)) {
      const p = persona(key);
      expect(hasFixedIdentity(p), key).toBe(true);
      expect(p.bank, key).toBeDefined();
      for (const at of DAYS) expect(personaHetu(p, at), key).toBe(code);
    }
    for (const p of DEMO_PERSONAS) {
      expect(p.bank !== undefined, p.key).toBe(hasFixedIdentity(p));
    }
  });

  it("keep their identity when they were born on a fixed day, and only then", () => {
    const [first, later] = [new Date(Date.UTC(2026, 8, 27)), new Date(Date.UTC(2031, 3, 2))];
    for (const p of DEMO_PERSONAS) {
      const same = personaHetu(p, first) === personaHetu(p, later);
      expect(same, p.key).toBe(hasFixedIdentity(p));
      // A history needs an identity that stays.
      if (p.group === "history") expect(hasFixedIdentity(p), p.key).toBe(true);
    }
  });

  it("are the ages they are there for, by the product's own age rule, whenever the demo runs", () => {
    const ageOf = (key: string, at: Date) => {
      const born = personaBirth(persona(key), at);
      return ageFromYearMonth(born.year, born.month, at);
    };
    for (const at of DAYS) {
      expect(ageOf("eetu", at), `eetu on ${at.toISOString()}`).toBe(18);
      expect(ageOf("lauri", at)).toBe(17);
      expect(ageOf("siiri", at)).toBe(99);
      // Turns 18 this month: 17 until the month's last day, as TD-14 counts.
      const lastDay = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
      expect(ageOf("venla", at)).toBe(at.getUTCDate() >= lastDay ? 18 : 17);
      for (const p of DEMO_PERSONAS.filter((p) => p.group !== "ages")) {
        const parsed = parseHetu(personaHetu(p, at));
        expect(parsed && isAdult(parsed, at), p.key).toBe(true);
      }
    }
  });

  it("say what the real broker says, in its claim names", () => {
    const claims = personaClaims(persona("kerttu"), DAYS[0] as Date);
    expect(claims).toEqual({
      "urn:oid:1.2.246.21": personaHetu(persona("kerttu"), DAYS[0] as Date),
      "urn:oid:1.3.6.1.5.5.7.9.1": "1980-02-01",
      "urn:oid:2.5.4.4": "Åkerlund",
      "urn:oid:1.2.246.575.1.14": "Kerttu",
      "urn:oid:2.16.840.1.113730.3.1.241": "Kerttu Åkerlund",
      acr: MOCK_BANK_ACR,
      amr: ["https://tunnistus-pp.telia.fi/uas/saml2/names/ac/oidc.mock.1"],
    });
  });
});

describe("the login page of the mock bank", () => {
  const page = renderBankPage(DEMO_PERSONAS);

  it("is the file docker compose mounts", () => {
    const file = resolve(import.meta.dirname, "../../../../services/mock-idp/login.html");
    // Stale? `pnpm demo:bank` writes it.
    expect(readFileSync(file, "utf8")).toBe(page);
  });

  it("has a button for every persona and the form the server reads", () => {
    for (const p of DEMO_PERSONAS) {
      expect(page).toContain(`data-persona="${p.key}"`);
      if (p.bank) expect(page).toContain(`On staging: ${p.bank.name}, ${p.bank.user}`);
    }
    expect(page).toMatch(/<form method="post" id="login">/);
    expect(page).toMatch(/name="username"/);
    expect(page).toMatch(/name="claims"/);
    // Nothing is fetched from anywhere and nothing is sent anywhere but back:
    // the page is one file, and its form has no action of its own.
    expect(page).not.toMatch(
      /(src|href|action)\s*=|fetch\(|import\(|url\(|@import|sendBeacon|XMLHttpRequest|WebSocket/i,
    );
    expect(
      page.match(/https?:\/\/[^"\s]+/g)?.every((url) => /ficora\.fi|telia\.fi/.test(url)),
    ).toBe(true);
  });

  it("computes, in its own script, the claims personaClaims computes", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1];
    if (!script) throw new Error("the page has no script");
    const context = createContext({ document: { addEventListener: () => undefined } });
    runInContext(script, context);
    for (const at of DAYS) {
      const fromPage = JSON.parse(
        runInContext(
          `JSON.stringify(PERSONAS.map((p) => claimsOf(p, new Date(${at.getTime()}))))`,
          context,
        ) as string,
      );
      expect(fromPage, at.toISOString()).toEqual(DEMO_PERSONAS.map((p) => personaClaims(p, at)));
    }
  });

  it("posts the persona of the button that was pressed, and nothing when none was", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
    const form = {
      elements: { username: { value: "testi" }, claims: { value: "{}" } },
      submitted: 0,
      submit() {
        this.submitted += 1;
      },
    };
    const listeners: Record<string, (event: unknown) => void> = {};
    const asked: string[] = [];
    const context = createContext({
      document: {
        addEventListener: (type: string, listener: (event: unknown) => void) => {
          listeners[type] = listener;
        },
        getElementById: (id: string) => {
          asked.push(id);
          return id === "login" ? form : null;
        },
      },
    });
    runInContext(script, context);
    const click = listeners.click;
    if (!click) throw new Error("the page listens to no click");

    // A press somewhere else on the page: nothing is posted.
    click({ target: { closest: () => null } });
    expect(form.submitted).toBe(0);
    expect(form.elements.username.value).toBe("testi");

    // The markup's own buttons, one after the other, found the way the page finds them.
    const selectors: string[] = [];
    for (const p of DEMO_PERSONAS) {
      expect(page).toContain(`<button type="button" data-persona="${p.key}">`);
      const before = Date.now();
      click({
        target: {
          closest: (selector: string) => {
            selectors.push(selector);
            return { dataset: { persona: p.key } };
          },
        },
      });
      const after = Date.now();
      expect(form.elements.username.value).toBe(p.key);
      const posted = JSON.parse(form.elements.claims.value) as Record<string, unknown>;
      // The page reads its own clock; the claims are those of the moment of the press.
      expect([before, after].map((at) => personaClaims(p, new Date(at)))).toContainEqual(posted);
    }
    expect(form.submitted).toBe(DEMO_PERSONAS.length);
    expect(new Set(selectors)).toEqual(new Set(["button[data-persona]"]));
    expect(new Set(asked)).toEqual(new Set(["login"]));
    // And the form the script looks for is the form of the page.
    expect(page).toContain('<form method="post" id="login">');
    expect(page).toContain('id="username" name="username"');
    expect(page).toContain('id="claims" name="claims"');
  });

  it("escapes what it is given, in the markup, in an attribute and in the script", () => {
    const hostile = renderBankPage([
      {
        key: 'x" onclick="alert(3)',
        given: '<img src=x onerror="alert(1)">',
        family: "</SCRIPT><script>alert(2)</script><!--",
        born: { year: 1990, month: 1, day: 1 },
        individual: 999,
        group: "walkthrough",
        note: "a & b ' c",
      },
    ]);
    expect(hostile).not.toContain("<img");
    expect(hostile).not.toMatch(/onclick="|onerror="/);
    expect(hostile.match(/<script/gi)).toHaveLength(1);
    expect(hostile.match(/<\/script/gi)).toHaveLength(1);
    // The generator's own comment is the only one.
    expect(hostile.match(/<!--/g)).toHaveLength(1);
    expect(hostile).toContain("a &#38; b &#39; c");
    // And the script still runs, and still says what personaClaims says.
    const script = /<script>([\s\S]*?)<\/script>/.exec(hostile)?.[1] ?? "";
    const context = createContext({ document: { addEventListener: () => undefined } });
    runInContext(script, context);
    expect(runInContext("JSON.stringify(claimsOf(PERSONAS[0], new Date(0)))", context)).toContain(
      "</SCRIPT><script>alert(2)</script><!--",
    );
  });

  it("refuses a persona whose code could be a person's", () => {
    const real = { ...persona("aino"), individual: 123 };
    expect(() => assertArtificial(real)).toThrow(/outside 900 to 999/);
    expect(() => personaHetu(real, DAYS[0] as Date)).toThrow(/outside 900 to 999/);
    expect(() => renderBankPage([real])).toThrow(/outside 900 to 999/);
    for (const individual of [899, 1000, 900.5, Number.NaN]) {
      expect(() => assertArtificial({ ...persona("aino"), individual })).toThrow();
    }
  });
});
