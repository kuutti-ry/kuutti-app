import { RESEARCH_FIELD_KEYS } from "@kuutti/schema";
import { parquetMetadata, parquetReadObjects, type SchemaElement } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";
import { type Cell, cellKey } from "./copy-census.ts";

/**
 * One day of the research copy as a Parquet file (#194, ADR-029 §2): flat
 * columns, one row group, the rows in a fixed order, so the same rows give
 * the same bytes. What a row may carry is the registry's and nothing else
 * (rule 5): never the account, the event's own id, the stored snapshot or any
 * text a person wrote. The order is by hour, name, pseudonym and props, never
 * by insertion: within the hour `at` is truncated to (ADR-011 §1), the order
 * of writing would say what happened first.
 */
export const COPY_FORMAT = "research-events/1";

/** One column per research field of the registry, `field_<key>`. */
const FIELD_COLUMNS = RESEARCH_FIELD_KEYS.map((key) => `field_${key}`);

const text = (name: string, required: boolean): SchemaElement => ({
  name,
  type: "BYTE_ARRAY",
  converted_type: "UTF8",
  logical_type: { type: "STRING" },
  repetition_type: required ? "REQUIRED" : "OPTIONAL",
});

const COLUMNS: SchemaElement[] = [
  {
    name: "at",
    type: "INT64",
    converted_type: "TIMESTAMP_MILLIS",
    logical_type: { type: "TIMESTAMP", isAdjustedToUTC: true, unit: "MILLIS" },
    repetition_type: "REQUIRED",
  },
  text("name", true),
  // Text rather than the UUID logical type, so that pandas reads a string.
  text("research_id", true),
  text("consent_version", true),
  text("pond", false),
  text("age_band", true),
  text("gender", false),
  ...FIELD_COLUMNS.map((column) => text(column, false)),
  {
    name: "props",
    type: "BYTE_ARRAY",
    converted_type: "JSON",
    logical_type: { type: "JSON" },
    repetition_type: "REQUIRED",
  },
];
const SCHEMA: SchemaElement[] = [{ name: "root", num_children: COLUMNS.length }, ...COLUMNS];

export type CopyRow = {
  /** Already truncated to the hour by track(). */
  at: Date;
  name: string;
  researchId: string;
  consentVersion: string;
  cell: Cell;
  /** As the registry's strict schema parsed them. */
  props: Record<string, unknown>;
};

export type DayMeta = {
  /** YYYY-MM-DD, UTC. */
  day: string;
  k: number;
  /** Rows the census left out. */
  dropped: number;
  /** Rows of the table the registry no longer reads (a retired name, props that do not parse). */
  unreadable: number;
};

const compare = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

/** The props with their keys in code-unit order: one spelling per value. */
function sortedProps(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).sort(([a], [b]) => compare(a, b)));
}

export function encodeDay(rows: readonly CopyRow[], meta: DayMeta): Uint8Array {
  const sorted = rows
    .map((row) => {
      const props = sortedProps(row.props);
      return { row, props, propsText: JSON.stringify(props), cell: cellKey(row.cell) };
    })
    .sort(
      (a, b) =>
        compare(a.row.at.getTime(), b.row.at.getTime()) ||
        compare(a.row.name, b.row.name) ||
        compare(a.row.researchId, b.row.researchId) ||
        compare(a.propsText, b.propsText) ||
        compare(a.cell, b.cell) ||
        compare(a.row.consentVersion, b.row.consentVersion),
    );
  const column = <T>(name: string, value: (s: (typeof sorted)[number]) => T) => ({
    name,
    data: sorted.map(value),
  });
  const buffer = parquetWriteBuffer({
    schema: SCHEMA,
    columnData: [
      column("at", (s) => s.row.at),
      column("name", (s) => s.row.name),
      column("research_id", (s) => s.row.researchId),
      column("consent_version", (s) => s.row.consentVersion),
      column("pond", (s) => s.row.cell.pond),
      column("age_band", (s) => s.row.cell.ageBand),
      column("gender", (s) => s.row.cell.gender),
      ...RESEARCH_FIELD_KEYS.map((key, i) =>
        column(FIELD_COLUMNS[i] as string, (s) => s.row.cell.fields[key] ?? null),
      ),
      column("props", (s) => s.props),
    ],
    // One row group: a day is small, and a reader gets it in one read.
    rowGroupSize: Math.max(1, sorted.length),
    kvMetadata: [
      { key: "kuutti.format", value: COPY_FORMAT },
      { key: "kuutti.day", value: meta.day },
      { key: "kuutti.k", value: String(meta.k) },
      {
        key: "kuutti.census",
        value:
          "a value is released when this file and the copy's files of the previous 90 days carry it for at least k distinct research_id whose research consent was live on the night this file was written (ADR-029 §4)",
      },
      { key: "kuutti.dropped", value: String(meta.dropped) },
      { key: "kuutti.unreadable", value: String(meta.unreadable) },
    ],
  });
  return new Uint8Array(buffer);
}

const arrayBufferOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/**
 * What a day's file released: each row's pseudonym and cell, for the census
 * of the days after it. A file that is not of this format stops the caller:
 * nothing is released without the count. A research field flagged after the
 * file was written reads as null there, as the file's readers see it.
 */
export async function releasedIn(bytes: Uint8Array): Promise<{ researchId: string; cell: Cell }[]> {
  const file = arrayBufferOf(bytes);
  const metadata = parquetMetadata(file);
  const format = metadata.key_value_metadata?.find((kv) => kv.key === "kuutti.format")?.value;
  if (format !== COPY_FORMAT) throw new Error("research copy: a file of another format");
  const present = new Set(metadata.schema.map((element) => element.name));
  const rows = await parquetReadObjects({
    file,
    columns: [
      "research_id",
      "pond",
      "age_band",
      "gender",
      ...FIELD_COLUMNS.filter((c) => present.has(c)),
    ],
  });
  return rows.map((row) => ({
    researchId: row.research_id as string,
    cell: {
      pond: row.pond as string | null,
      ageBand: row.age_band as string,
      gender: row.gender as string | null,
      fields: Object.fromEntries(
        RESEARCH_FIELD_KEYS.map((key, i) => [
          key,
          (row[FIELD_COLUMNS[i] as string] as string | null | undefined) ?? null,
        ]),
      ),
    },
  }));
}
