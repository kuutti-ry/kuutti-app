import { parquetMetadata, parquetReadObjects } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";
import { describe, expect, it } from "vitest";
import { WITHHELD } from "./copy-census.ts";
import { COPY_FORMAT, type CopyRow, encodeDay, releasedIn } from "./copy-file.ts";

// One day of the research copy as Parquet (ADR-029 §2), read back with
// hyparquet, the writer's companion reader: the values, the nulls and the
// withheld sentinel, the physical and logical types a reader such as DuckDB or
// pandas goes by, the key-value metadata, and the same bytes for the same rows.

const META = { day: "2026-10-16", k: 10, dropped: 2, unreadable: 1 };

const row = (over: Partial<CopyRow> = {}): CopyRow => ({
  at: new Date("2026-10-16T09:00:00.000Z"),
  name: "profile_saved",
  researchId: "00000000-0000-4000-8000-000000000001",
  consentVersion: "research-2026-09-26",
  cell: { pond: "otaniemi", ageBand: "25-29", gender: "woman", fields: { intent: "long_term" } },
  props: { complete: true, approvedPhotos: 3 },
  ...over,
});

const ROWS: CopyRow[] = [
  row({
    at: new Date("2026-10-16T23:00:00.000Z"),
    researchId: "00000000-0000-4000-8000-000000000002",
    cell: { pond: WITHHELD, ageBand: "18-29", gender: null, fields: { intent: WITHHELD } },
    props: { approvedPhotos: 0, complete: false },
  }),
  row({
    name: "research_opt_in",
    cell: { pond: null, ageBand: "25-29", gender: "man", fields: { intent: null } },
    props: { sinceRegistrationD: 2, accountActive: true },
  }),
  row(),
];

const view = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

describe("a day's file", () => {
  it("reads back in a fixed order with its nulls and withheld values", async () => {
    const rows = await parquetReadObjects({ file: view(encodeDay(ROWS, META)) });
    expect(rows).toEqual([
      {
        at: new Date("2026-10-16T09:00:00.000Z"),
        name: "profile_saved",
        research_id: "00000000-0000-4000-8000-000000000001",
        consent_version: "research-2026-09-26",
        pond: "otaniemi",
        age_band: "25-29",
        gender: "woman",
        field_intent: "long_term",
        props: { approvedPhotos: 3, complete: true },
      },
      {
        at: new Date("2026-10-16T09:00:00.000Z"),
        name: "research_opt_in",
        research_id: "00000000-0000-4000-8000-000000000001",
        consent_version: "research-2026-09-26",
        pond: null,
        age_band: "25-29",
        gender: "man",
        field_intent: null,
        props: { accountActive: true, sinceRegistrationD: 2 },
      },
      {
        at: new Date("2026-10-16T23:00:00.000Z"),
        name: "profile_saved",
        research_id: "00000000-0000-4000-8000-000000000002",
        consent_version: "research-2026-09-26",
        pond: "*",
        age_band: "18-29",
        gender: null,
        field_intent: "*",
        props: { approvedPhotos: 0, complete: false },
      },
    ]);
  });

  it("writes the props' keys in one order, whatever order they came in", async () => {
    const [read] = await parquetReadObjects({
      file: view(encodeDay([row({ props: { complete: true, approvedPhotos: 3 } })], META)),
    });
    expect(Object.keys(read?.props as object)).toEqual(["approvedPhotos", "complete"]);
  });

  it("names its columns and their types, and nothing else: no account, no event id, no snapshot", () => {
    const metadata = parquetMetadata(view(encodeDay(ROWS, META)));
    const string = { type: "BYTE_ARRAY", converted_type: "UTF8", logical_type: { type: "STRING" } };
    expect(metadata.schema.slice(1)).toEqual([
      {
        name: "at",
        type: "INT64",
        repetition_type: "REQUIRED",
        converted_type: "TIMESTAMP_MILLIS",
        logical_type: { type: "TIMESTAMP", isAdjustedToUTC: true, unit: "MILLIS" },
      },
      { name: "name", ...string, repetition_type: "REQUIRED" },
      { name: "research_id", ...string, repetition_type: "REQUIRED" },
      { name: "consent_version", ...string, repetition_type: "REQUIRED" },
      { name: "pond", ...string, repetition_type: "OPTIONAL" },
      { name: "age_band", ...string, repetition_type: "REQUIRED" },
      { name: "gender", ...string, repetition_type: "OPTIONAL" },
      { name: "field_intent", ...string, repetition_type: "OPTIONAL" },
      {
        name: "props",
        type: "BYTE_ARRAY",
        repetition_type: "REQUIRED",
        converted_type: "JSON",
        logical_type: { type: "JSON" },
      },
    ]);
    expect(metadata.num_rows).toBe(3n);
    expect(metadata.row_groups).toHaveLength(1);
    expect(metadata.key_value_metadata).toEqual([
      { key: "kuutti.format", value: COPY_FORMAT },
      { key: "kuutti.day", value: "2026-10-16" },
      { key: "kuutti.k", value: "10" },
      { key: "kuutti.census", value: expect.stringContaining("at least k distinct research_id") },
      { key: "kuutti.dropped", value: "2" },
      { key: "kuutti.unreadable", value: "1" },
    ]);
  });

  it("a day without events is a file with the whole schema and no rows", async () => {
    const empty = encodeDay([], { ...META, dropped: 0, unreadable: 0 });
    const metadata = parquetMetadata(view(empty));
    expect(metadata.num_rows).toBe(0n);
    expect(metadata.schema.map((e) => e.name)).toEqual(
      parquetMetadata(view(encodeDay(ROWS, META))).schema.map((e) => e.name),
    );
    expect(await parquetReadObjects({ file: view(empty) })).toEqual([]);
    expect(await releasedIn(empty)).toEqual([]);
  });

  it("the same rows give the same bytes, in whatever order they come", () => {
    const once = encodeDay(ROWS, META);
    expect(encodeDay([...ROWS].reverse(), META)).toEqual(once);
    // Two rows equal in every ordered column but the cell still sort one way.
    const twins = [
      row({ cell: { ...row().cell, pond: "kallio" } }),
      row({ consentVersion: "research-2026-10-30" }),
      row(),
    ];
    expect(encodeDay(twins, META)).toEqual(encodeDay([...twins].reverse(), META));
  });
});

describe("what a file released, read for the census", () => {
  it("is each row's pseudonym and cell", async () => {
    expect(await releasedIn(encodeDay(ROWS, META))).toEqual([
      { researchId: "00000000-0000-4000-8000-000000000001", cell: ROWS[2]?.cell },
      { researchId: "00000000-0000-4000-8000-000000000001", cell: ROWS[1]?.cell },
      { researchId: "00000000-0000-4000-8000-000000000002", cell: ROWS[0]?.cell },
    ]);
  });

  it("reads a research field the file has no column for as unanswered", async () => {
    const older = parquetWriteBuffer({
      columnData: [
        { name: "research_id", data: ["r1"], type: "STRING" },
        { name: "pond", data: ["otaniemi"], type: "STRING" },
        { name: "age_band", data: ["25-29"], type: "STRING" },
        { name: "gender", data: [null], type: "STRING" },
      ],
      kvMetadata: [{ key: "kuutti.format", value: COPY_FORMAT }],
    });
    expect(await releasedIn(new Uint8Array(older))).toEqual([
      {
        researchId: "r1",
        cell: { pond: "otaniemi", ageBand: "25-29", gender: null, fields: { intent: null } },
      },
    ]);
  });

  it("refuses a file of another format, and one that is no Parquet at all", async () => {
    const other = parquetWriteBuffer({
      columnData: [{ name: "research_id", data: ["r1"], type: "STRING" }],
    });
    await expect(releasedIn(new Uint8Array(other))).rejects.toThrow(/another format/);
    await expect(releasedIn(new TextEncoder().encode("not parquet"))).rejects.toThrow();
  });
});
