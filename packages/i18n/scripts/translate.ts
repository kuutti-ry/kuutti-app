/**
 * `pnpm i18n:translate`: fills Finnish and Swedish texts by machine, flagged
 * `machine: true` for a native reviewer (#13, #55, TD-17).
 *
 *   pnpm i18n:translate [--locale fi|sv] [--prefix p.] [--keys a,b]
 *                       [--retranslate | --stale] [--chunk-size 40]
 *                       [--mode sync|batch] [--dry-run] [--compare]
 *   pnpm i18n:translate --batch-id <id>      collect a batch submitted earlier
 *
 * By default only texts that do not exist yet are translated. --retranslate
 * writes machine text again (never reviewed text) and needs --prefix or
 * --keys; --stale redoes reviewed text whose English or translation changed.
 * --compare sends the requests for machine text (or --stale) under a --prefix
 * or --keys and prints old and new side by side, writing nothing. legal.*
 * keys are never sent; admin.* keys are English only. What still waits for a
 * reviewer is `pnpm i18n:review --list`.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  anthropicTranslator,
  type BatchChunk,
  type BatchRequests,
  batchState,
  collectBatch,
  formatUsage,
  submitBatch,
} from "./lib/anthropic-translator.ts";
import { reviewHash } from "./lib/review-hash.ts";
import {
  isTranslatedLocale,
  parseMessages,
  TRANSLATED_LOCALES,
  type TranslatedLocale,
} from "./lib/schema.ts";
import {
  applyTranslations,
  planChunks,
  rejectionReason,
  reviewedExamples,
  type Selection,
  selectForTranslation,
  type TranslationContext,
} from "./lib/translate.ts";

const root = resolve(import.meta.dirname, "..");
const file = resolve(root, "messages.yaml");
// Gitignored: what each request of a batch asked for, until the batch is collected.
const batches = resolve(root, ".batches");

const { values } = parseArgs({
  options: {
    locale: { type: "string" },
    prefix: { type: "string" },
    keys: { type: "string" },
    retranslate: { type: "boolean", default: false },
    stale: { type: "boolean", default: false },
    "chunk-size": { type: "string" },
    mode: { type: "string" },
    "batch-id": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    compare: { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

// An empty value is no value: `--prefix=` or `--keys ""` would otherwise select
// every namespace, and without --dry-run send it and write the answers (#235).
for (const [name, value] of Object.entries(values)) {
  if (value === "") fail(`--${name} takes a value`);
}

if (values.locale !== undefined && !isTranslatedLocale(values.locale)) {
  fail(`--locale is ${TRANSLATED_LOCALES.join(" or ")}`);
}
const locales: TranslatedLocale[] = isTranslatedLocale(values.locale)
  ? [values.locale]
  : [...TRANSLATED_LOCALES];
const chunkSize = Number(values["chunk-size"] ?? "40");
if (!Number.isInteger(chunkSize) || chunkSize < 1) fail("--chunk-size is a whole number");
const mode = values.mode ?? "sync";
if (mode !== "sync" && mode !== "batch") fail("--mode is sync or batch");
if (values.retranslate && values.stale) {
  fail("--retranslate and --stale select different texts; pick one");
}
if (values.compare && mode === "batch") fail("--compare runs in sync mode");

// Collecting a batch is its own command: the batch already decided what it covers.
const batchId = values["batch-id"];
if (batchId !== undefined) {
  const others = [
    "locale",
    "prefix",
    "keys",
    "retranslate",
    "stale",
    "chunk-size",
    "mode",
    "dry-run",
    "compare",
  ]
    .filter((name) => {
      const value = values[name as keyof typeof values];
      return value !== undefined && value !== false;
    })
    .map((name) => `--${name}`);
  if (others.length > 0) fail(`--batch-id takes no other options (got ${others.join(", ")})`);
  if (!/^[A-Za-z0-9_-]+$/.test(batchId)) fail("that is not a batch id");
}

const selection: Selection = {
  // --compare shows what the translator makes of text that exists: machine text, or --stale.
  mode: values.stale ? "stale" : values.retranslate || values.compare ? "retranslate" : "missing",
  ...(values.prefix ? { prefix: values.prefix } : {}),
  ...(values.keys ? { keys: values.keys.split(",").map((key) => key.trim()) } : {}),
};
if ((selection.mode === "retranslate" || values.compare) && !values.prefix && !values.keys) {
  // Machine text across the whole file may be in a reviewer's hands, and a compare costs money.
  fail(`${values.compare ? "--compare" : "--retranslate"} needs --prefix or --keys`);
}

const glossary = readFileSync(resolve(root, "glossary.yaml"), "utf8");
const tone = readFileSync(resolve(root, "..", "..", "docs", "i18n", "tone.md"), "utf8");
const contextFor = (
  messages: ReturnType<typeof parseMessages>,
  locale: TranslatedLocale,
  namespace: string,
): TranslationContext => ({
  glossary,
  tone,
  examples: reviewedExamples(messages, locale, namespace),
});

let wrote = false;

/**
 * Writes one locale's answers into the file as it is now. Only keys that were
 * asked for and still need the text are written; one asked for and left
 * unanswered is reported, like a refused answer.
 */
function apply(
  locale: TranslatedLocale,
  asked: readonly string[],
  translations: Record<string, string>,
  within: Selection,
): number {
  const yamlText = readFileSync(file, "utf8");
  const messages = parseMessages(yamlText);
  const wanted = new Set(asked);
  const items = selectForTranslation(messages, locale, within).filter((item) =>
    wanted.has(item.key),
  );
  const result = applyTranslations(yamlText, messages, locale, translations, items);
  if (result.written.length > 0) {
    writeFileSync(file, result.yaml);
    wrote = true;
  }
  for (const [key, reason] of Object.entries(result.rejected)) {
    console.error(`✖ ${locale} ${key}: ${reason}`);
  }
  return result.written.length;
}

// What a batch asked for, kept on disk until it is collected: read back through
// a schema like any input (a day may pass, and a file is a file), with the
// fingerprint of each key's English at the time, so an answer made from an
// older English is never written under a newer one.
const Manifest = z.strictObject({
  selection: z.strictObject({
    mode: z.enum(["missing", "retranslate", "stale"]),
    keys: z.array(z.string()).optional(),
    prefix: z.string().optional(),
  }),
  requests: z.record(
    z.string(),
    z.strictObject({ locale: z.enum(TRANSLATED_LOCALES), keys: z.array(z.string()) }),
  ),
  sources: z.record(z.string(), z.string()),
});
type Manifest = { selection: Selection; requests: BatchRequests; sources: Record<string, string> };

/** The fingerprint of a key's English: the review hash of it alone. */
const sourceOf = (en: string): string => reviewHash(en, "");

async function collect(id: string): Promise<void> {
  const path = resolve(batches, `${id}.json`);
  if (!existsSync(path)) {
    fail(
      `no record of batch ${id} in packages/i18n/.batches; it is collected where it was submitted`,
    );
  }
  const manifest: Manifest = Manifest.parse(JSON.parse(readFileSync(path, "utf8")));
  const state = await batchState(id);
  if (!state.ended) {
    const c = state.counts;
    console.log(
      `Batch ${id} is still running: ${c.processing} processing, ${c.succeeded} done, ${c.errored} errored. ` +
        `Run \`pnpm i18n:translate --batch-id ${id}\` again later.`,
    );
    return;
  }
  const outcome = await collectBatch(id, manifest.requests);
  const now = parseMessages(readFileSync(file, "utf8"));
  for (const locale of TRANSLATED_LOCALES) {
    const asked = Object.values(manifest.requests)
      .filter((request) => request.locale === locale)
      .flatMap((request) => request.keys)
      .filter((key) => {
        const en = Object.hasOwn(now, key) ? now[key]?.en : undefined;
        if (en !== undefined && manifest.sources[key] === sourceOf(en)) return true;
        console.error(
          `✖ ${locale} ${key}: the English changed since the batch was submitted; translate it again`,
        );
        return false;
      });
    if (asked.length === 0) continue;
    const written = apply(locale, asked, outcome.translations[locale], manifest.selection);
    console.log(`${locale}: wrote ${written}, flagged machine: true`);
  }
  for (const [request, reason] of Object.entries(outcome.failed)) {
    console.error(`✖ ${request}: ${reason}`);
  }
  if (outcome.ignored > 0)
    console.log(`Ignored ${outcome.ignored} answers for keys not asked for.`);
  console.log(`Batch ${id}: ${formatUsage(outcome.usage)} (at batch prices, half of sync)`);
  unlinkSync(path);
}

/** Terminal-safe: an answer is shown as a JSON string, so no control character reaches the terminal. */
const shown = (text: string | undefined): string =>
  text === undefined ? "(none)" : JSON.stringify(text);

if (batchId !== undefined) {
  await collect(batchId);
} else {
  const messages = parseMessages(readFileSync(file, "utf8"));
  const plan = locales.map((locale) => ({
    locale,
    chunks: planChunks(selectForTranslation(messages, locale, selection), chunkSize),
  }));

  for (const { locale, chunks } of plan) {
    const count = chunks.reduce((sum, chunk) => sum + chunk.items.length, 0);
    console.log(
      count === 0
        ? `${locale}: nothing to translate (${selection.mode})`
        : `${locale}: ${count} texts (${selection.mode}) in ${chunks.length} requests`,
    );
    if (values["dry-run"]) {
      chunks.forEach((chunk, index) => {
        const examples = contextFor(messages, locale, chunk.namespace).examples?.length ?? 0;
        console.log(
          `  request ${index + 1}: ${chunk.namespace}, ${chunk.items.length} keys, ${examples} examples\n` +
            chunk.items.map((item) => `    ${item.key}`).join("\n"),
        );
      });
    }
  }

  if (values["dry-run"]) {
    console.log("Dry run: nothing sent.");
  } else if (mode === "batch") {
    const chunks: BatchChunk[] = plan.flatMap(({ locale, chunks }) =>
      chunks.map((chunk) => ({
        locale,
        items: chunk.items,
        context: contextFor(messages, locale, chunk.namespace),
      })),
    );
    if (chunks.length > 0) {
      const { id, requests } = await submitBatch(chunks);
      // The id names a file: the same check --batch-id gets.
      if (!/^[A-Za-z0-9_-]+$/.test(id))
        fail(`the batch id is not a file name: ${JSON.stringify(id)}`);
      const sources = Object.fromEntries(
        chunks.flatMap((chunk) => chunk.items.map((item) => [item.key, sourceOf(item.en)])),
      );
      mkdirSync(batches, { recursive: true });
      writeFileSync(
        resolve(batches, `${id}.json`),
        `${JSON.stringify({ selection, requests, sources } satisfies Manifest, null, 2)}\n`,
      );
      console.log(
        `Submitted batch ${id} (${chunks.length} requests). Most finish within an hour, all within 24.\n` +
          `Collect it with: pnpm i18n:translate --batch-id ${id}`,
      );
    }
  } else {
    const translate = anthropicTranslator({ log: (line) => console.log(`  ${line}`) });
    for (const { locale, chunks } of plan) {
      let written = 0;
      for (const chunk of chunks) {
        const asked = chunk.items.map((item) => item.key);
        let translations: Record<string, string>;
        try {
          translations = await translate(
            locale,
            chunk.items,
            contextFor(messages, locale, chunk.namespace),
          );
        } catch (error) {
          // One failed request costs its keys, not the run.
          for (const key of asked) console.error(`✖ ${locale} ${key}: ${(error as Error).message}`);
          continue;
        }
        if (values.compare) {
          for (const item of chunk.items) {
            const text = translations[item.key];
            const refused =
              text === undefined
                ? undefined
                : rejectionReason(item.en, text, locale, item.max_length);
            console.log(
              `  ${item.key}\n    en:  ${shown(item.en)}\n    now: ${shown(messages[item.key]?.[locale])}\n    new: ${shown(text)}` +
                (refused ? `\n    ✖ would be refused: ${refused}` : ""),
            );
          }
        } else {
          written += apply(locale, asked, translations, selection);
        }
      }
      if (!values.compare && chunks.length > 0) {
        console.log(`${locale}: wrote ${written}, flagged machine: true`);
      }
    }
    if (values.compare) console.log("Compare: messages.yaml not written.");
  }
}
if (wrote) console.log("Now run `pnpm i18n:build` and commit messages.yaml with src/generated.");
