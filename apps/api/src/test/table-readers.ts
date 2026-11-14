import { withoutComments } from "./sources.ts";

// What safety/no-signal.test.ts takes for a statement that reads or writes one
// of the tables it guards. Here, beside sources.ts, so that the guard's attacks
// (#380) run the same reading; the guard's own file says why it reads.

/**
 * Whether the source reads or writes the table: in SQL, the keyword and the
 * name across any whitespace, a line break included, with or without the
 * schema and quotes; through drizzle's builder, the table handed to a
 * from, join, insert, update or delete.
 */
function names(source: string, table: string): boolean {
  let code = withoutComments(source);
  const names = [table];
  for (const alias of code.matchAll(new RegExp(`\\b${table}\\s+as\\s+(\\w+)`, "g"))) {
    if (alias[1]) names.push(alias[1]);
  }
  // A literal table name concatenated into SQL is still a static reader.
  for (const match of code.matchAll(
    new RegExp(`\\bconst\\s+(\\w+)\\s*=\\s*["']${table}["']`, "g"),
  )) {
    if (match[1])
      code = code.replace(new RegExp(`["']\\s*\\+\\s*${match[1]}\\b`, "g"), ` ${table}`);
  }
  const identifier = `(?:(?:"?\\w+"?)\\s*\\.\\s*)?"?${table}"?(?![\\w])`;
  const sql = new RegExp(
    `\\b(FROM|JOIN|UPDATE|USING|INSERT\\s+INTO)\\s+(?:ONLY\\s+)?${identifier}`,
    "i",
  );
  const commaJoin = new RegExp(
    `\\b(?:SELECT|DELETE)\\b[^;\x60]*?\\bFROM\\b(?:(?!\\b(?:WHERE|GROUP|ORDER|LIMIT|RETURNING)\\b)[^;\x60])*?,\\s*${identifier}`,
    "i",
  );
  const builder = new RegExp(
    `\\.(from|innerJoin|leftJoin|rightJoin|fullJoin|crossJoin|insert|update|delete|\\$count)\\(\\s*(?:alias\\(\\s*)?(\\w+\\.)?(?:${names.join("|")})\\s*[,)]`,
  );
  const relational = new RegExp(`\\.query\\.${table}\\.(?:findMany|findFirst)\\s*\\(`);
  return sql.test(code) || commaJoin.test(code) || builder.test(code) || relational.test(code);
}

export const readsBlock = (source: string) =>
  names(source, "block") || /blocked_between/.test(withoutComments(source));
export const readsReport = (source: string) => names(source, "report");
export const readsMessage = (source: string) => names(source, "message");
export const readsReportCopy = (source: string) =>
  names(source, "report_message") || names(source, "reportMessage");
export const readsStar = (source: string) => names(source, "star");
