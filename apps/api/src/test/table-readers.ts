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
  const code = withoutComments(source);
  const sql = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+(public\\.)?"?${table}"?(?![\\w])`, "i");
  const builder = new RegExp(
    `\\.(from|innerJoin|leftJoin|rightJoin|fullJoin|insert|update|delete)\\(\\s*(\\w+\\.)?${table}\\s*[,)]`,
  );
  return sql.test(code) || builder.test(code);
}

export const readsBlock = (source: string) =>
  names(source, "block") || /blocked_between/.test(withoutComments(source));
export const readsReport = (source: string) => names(source, "report");
export const readsMessage = (source: string) => names(source, "message");
export const readsReportCopy = (source: string) =>
  names(source, "report_message") || names(source, "reportMessage");
export const readsStar = (source: string) => names(source, "star");
