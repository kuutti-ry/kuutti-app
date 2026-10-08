/**
 * Finnish personal identity code (henkilötunnus) format: DDMMYY, a century
 * sign, a three-digit individual number, and a check character.
 *
 * This module knows the format only. It derives what the product needs (birth
 * year and month, the 18+ check) and nothing else: legal sex is encoded in the
 * individual number and is deliberately never derived (TD-14, rule 3). Real
 * codes exist only in memory inside the OIDC callback (rule 1); generated ones
 * feed seeds and tests.
 */

const CHECK_CHARS = "0123456789ABCDEFHJKLMNPRSTUVWXY";

/** Century signs after the 2023 reform: several signs per century. */
export const CENTURY_SIGNS: Readonly<Record<string, number>> = {
  "+": 1800,
  "-": 1900,
  Y: 1900,
  X: 1900,
  W: 1900,
  V: 1900,
  U: 1900,
  A: 2000,
  B: 2000,
  C: 2000,
  D: 2000,
  E: 2000,
  F: 2000,
};

export type ParsedHetu = {
  birthYear: number;
  birthMonth: number;
  birthDay: number;
  centurySign: string;
  individualNumber: number;
};

const HETU = /^(\d{2})(\d{2})(\d{2})([+\-YXWVUA-F])(\d{3})([0-9A-Z])$/;

export function checkCharacter(ddmmyy: string, individual: string): string {
  const n = Number.parseInt(`${ddmmyy}${individual}`, 10);
  return CHECK_CHARS[n % 31] as string;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Which check a refused code failed: the shape (eleven characters, a known
 * century sign), the check character, the date, or an individual number
 * below 002. Says nothing about the code itself, so it may be logged (rule 1);
 * without it a refusal on the test bed is a guess.
 */
export type HetuProblem = "format" | "checksum" | "date" | "individual";

function analyse(input: string): { parsed: ParsedHetu } | { problem: HetuProblem } {
  const m = HETU.exec(input.trim().toUpperCase());
  if (!m) return { problem: "format" };
  const [, dd, mm, yy, sign, individual, check] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const century = CENTURY_SIGNS[sign];
  if (century === undefined) return { problem: "format" };
  if (checkCharacter(`${dd}${mm}${yy}`, individual) !== check) return { problem: "checksum" };
  const birthYear = century + Number.parseInt(yy, 10);
  const birthMonth = Number.parseInt(mm, 10);
  const birthDay = Number.parseInt(dd, 10);
  if (birthMonth < 1 || birthMonth > 12) return { problem: "date" };
  if (birthDay < 1 || birthDay > daysInMonth(birthYear, birthMonth)) return { problem: "date" };
  const individualNumber = Number.parseInt(individual, 10);
  if (individualNumber < 2) return { problem: "individual" };
  return { parsed: { birthYear, birthMonth, birthDay, centurySign: sign, individualNumber } };
}

/** Returns null for anything that is not a well-formed, checksum-valid code with a real date. */
export function parseHetu(input: string): ParsedHetu | null {
  const result = analyse(input);
  return "parsed" in result ? result.parsed : null;
}

/** The check a code fails, or null for a code `parseHetu` accepts. */
export function hetuProblem(input: string): HetuProblem | null {
  const result = analyse(input);
  return "problem" in result ? result.problem : null;
}

/**
 * Age as if born on the last day of the birth month (TD-14): never overstates,
 * needs only year and month, self-updating.
 */
export function ageFromYearMonth(birthYear: number, birthMonth: number, at: Date): number {
  const lastDay = daysInMonth(birthYear, birthMonth);
  let age = at.getUTCFullYear() - birthYear;
  const birthdayThisYear = Date.UTC(at.getUTCFullYear(), birthMonth - 1, lastDay);
  if (at.getTime() < birthdayThisYear) age -= 1;
  return age;
}

export function isAdult(parsed: ParsedHetu, at: Date = new Date()): boolean {
  return ageFromYearMonth(parsed.birthYear, parsed.birthMonth, at) >= 18;
}

export type Rng = () => number;

/**
 * A well-formed code for seeds and tests. Individual numbers stay in 002–899
 * (900+ are temporary identities). The century sign is chosen at random among
 * the signs valid for the century, so every separator gets exercised.
 */
export function generateHetu(
  rng: Rng,
  options: { minAge?: number; maxAge?: number; at?: Date } = {},
): string {
  const at = options.at ?? new Date();
  const minAge = options.minAge ?? 18;
  const maxAge = options.maxAge ?? 70;
  const age = minAge + Math.floor(rng() * (maxAge - minAge + 1));
  const birthMonth = 1 + Math.floor(rng() * 12);
  // The product's age rule counts a birthday on the last day of the birth
  // month. A month later in the year than `at` makes the person a year
  // younger under that rule, so move the year back in that case: the result
  // is `age` or `age + 1`, never below minAge.
  let birthYear = at.getUTCFullYear() - age;
  if (ageFromYearMonth(birthYear, birthMonth, at) < age) birthYear -= 1;
  const maxDay = daysInMonth(birthYear, birthMonth);
  const birthDay = 1 + Math.floor(rng() * maxDay);
  const century = Math.floor(birthYear / 100) * 100;
  const signs = Object.entries(CENTURY_SIGNS)
    .filter(([, c]) => c === century)
    .map(([s]) => s);
  const sign = signs[Math.floor(rng() * signs.length)] ?? "-";
  const individual = String(2 + Math.floor(rng() * 898)).padStart(3, "0");
  const ddmmyy = `${String(birthDay).padStart(2, "0")}${String(birthMonth).padStart(2, "0")}${String(birthYear % 100).padStart(2, "0")}`;
  return `${ddmmyy}${sign}${individual}${checkCharacter(ddmmyy, individual)}`;
}
