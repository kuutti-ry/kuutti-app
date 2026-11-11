import { isMap, YAMLMap } from "yaml";
import type { TranslatedLocale } from "./schema.ts";

// A text's two marks in messages.yaml, each a flow map by locale: `machine`
// (written by a machine, awaiting a native review) and `reviewed` (the hash a
// native reviewer approved). Only `markReviewed`, under --approve and --import,
// writes `reviewed`.

/** Takes `locale` out of the entry's `field` map, and the map with its last locale. */
export function unmark(
  entry: YAMLMap,
  field: "machine" | "reviewed",
  locale: TranslatedLocale,
): void {
  const marks = entry.get(field);
  if (isMap(marks)) {
    marks.delete(locale);
    if (marks.items.length === 0) entry.delete(field);
  }
}

/** Sets `locale` in the entry's `field` map, making the flow map where there is none. */
export function mark(
  entry: YAMLMap,
  field: "machine" | "reviewed",
  locale: TranslatedLocale,
  value: unknown,
): void {
  const marks = entry.get(field);
  if (isMap(marks)) {
    marks.set(locale, value);
    return;
  }
  const made = new YAMLMap();
  made.flow = true;
  made.set(locale, value);
  entry.set(field, made);
}
