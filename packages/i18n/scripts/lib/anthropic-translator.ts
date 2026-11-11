import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { TranslatedLocale } from "./schema.ts";
import type { TranslationContext, TranslationItem, Translator } from "./translate.ts";

/**
 * The translator behind `pnpm i18n:translate` (#13, #55): the Claude API with
 * structured output, one request per chunk of keys (sync) or one Message Batch
 * for every chunk (batch). Credentials come from the developer's environment
 * (ANTHROPIC_API_KEY or an `ant auth login` profile), never from the
 * repository. A request carries message text, the glossary, the tone guide
 * and approved examples, nothing else. Its output is a draft: only the keys a
 * request asked for are kept, and every value is written with machine: true
 * for a native reviewer to approve (rules/i18n.md).
 */

export const MODEL = "claude-opus-5-5";
const MAX_TOKENS = 16000;
// Opus 5.5 thinks at "medium" unless told otherwise; "high" is the level
// Opus 5 translated at by default.
const EFFORT = "high" as const;
// fallbacks: "default" re-runs a request the model's classifiers decline on
// the model Anthropic recommends for that case, in the same call. The Batches
// API refuses it, so batch requests go without.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const LANGUAGE = { fi: "Finnish", sv: "Swedish (as written in Finland)" } as const;

// One answer shape for every request, so that nothing but the items differs
// between requests. The keys are checked against the request's own afterwards:
// the API enforces the shape, not which keys come back.
const Output = z.object({
  translations: z.array(z.object({ key: z.string(), text: z.string() })),
});

/**
 * The system prompt: the instructions, then the tone guide and glossary. Both
 * are the same for every request of a locale, so the second block carries a
 * cache breakpoint (whether later requests read it shows as `cache read`).
 */
function systemBlocks(
  locale: TranslatedLocale,
  context: TranslationContext,
): Anthropic.TextBlockParam[] {
  return [
    {
      type: "text",
      text: [
        `You translate the user interface text of Kuutti, a free, non-commercial Finnish dating app, from English into ${LANGUAGE[locale]}.`,
        "Each item has a key, the English text and a description of where the text appears. Return one translation per key, for exactly the keys given.",
        "The text is ICU MessageFormat. Keep every argument name and the whole plural or select structure exactly as in the English source, and add every plural category the target language needs.",
        "Never inflect a dynamic value: an argument such as {pond} or {name} may only stand where the language needs no case ending on it. Restructure the sentence instead (for example after a colon).",
        "An item with max_length must fit in that many characters.",
        "Examples, when given, are approved translations from the same part of the app: follow their wording and their terms.",
        "Follow the tone guide. A glossary term that has a translation must be used exactly; a term without one is explained by its definition only.",
      ].join("\n\n"),
    },
    {
      type: "text",
      text: `<tone_guide>\n${context.tone}\n</tone_guide>\n\n<glossary>\n${context.glossary}\n</glossary>`,
      cache_control: { type: "ephemeral" },
    },
  ];
}

/** The user turn: the items and the examples, as JSON. Nothing else is sent. */
function userContent(items: readonly TranslationItem[], context: TranslationContext): string {
  return JSON.stringify({ items, examples: context.examples ?? [] }, null, 2);
}

/** What a request asks, in sync and batch mode alike; the sync adds the fallback, which batches refuse. */
function requestOf(
  locale: TranslatedLocale,
  items: readonly TranslationItem[],
  context: TranslationContext,
) {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" as const },
    system: systemBlocks(locale, context),
    messages: [{ role: "user" as const, content: userContent(items, context) }],
    output_config: { effort: EFFORT, format: zodOutputFormat(Output) },
  };
}

/** Only the keys a request asked for, each once; the rest are counted, never kept. */
function keep(
  asked: readonly string[],
  translations: readonly { key: string; text: string }[],
): { kept: Record<string, string>; ignored: number } {
  const wanted = new Set(asked);
  const kept: Record<string, string> = {};
  let ignored = 0;
  for (const { key, text } of translations) {
    if (wanted.has(key) && !Object.hasOwn(kept, key)) {
      Object.defineProperty(kept, key, { value: text, enumerable: true, writable: true });
    } else {
      ignored += 1;
    }
  }
  return { kept, ignored };
}

/** Token counts of one response, as `pnpm i18n:translate` reports them. */
export type Usage = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

const usageOf = (usage: Anthropic.Usage): Usage => ({
  input: usage.input_tokens,
  output: usage.output_tokens,
  cacheWrite: usage.cache_creation_input_tokens ?? 0,
  cacheRead: usage.cache_read_input_tokens ?? 0,
});

export const formatUsage = (usage: Usage): string =>
  `${usage.input} input, ${usage.cacheRead} cache read, ${usage.cacheWrite} cache write, ${usage.output} output tokens`;

export type TranslatorOptions = {
  /** The API client; tests pass a stand-in, the CLI a real one. */
  client?: Anthropic;
  /** Where the usage of each request goes. */
  log?: (line: string) => void;
};

/**
 * Sync mode: one request per chunk. A declined request is re-run on the
 * fallback model server-side; a request still declined, cut off or off the
 * schema throws, and the caller reports that chunk's keys and goes on.
 */
export function anthropicTranslator(options: TranslatorOptions = {}): Translator {
  const client = options.client ?? new Anthropic();
  return async (locale, items, context) => {
    const response = await client.beta.messages.parse({
      ...requestOf(locale, items, context),
      betas: [FALLBACK_BETA],
      fallbacks: "default",
    });
    // The fallback leaves its mark in the usage iterations (the model id alone may be a snapshot name).
    const fellBack = (response.usage.iterations ?? []).some(
      (entry) => entry.type === "fallback_message",
    );
    options.log?.(
      `${locale}: ${items.length} keys, ${formatUsage(usageOf(response.usage))}${
        fellBack ? `, answered by ${response.model} (fallback)` : ""
      }`,
    );

    // A refusal or a cut-off answer is reported, never half-written.
    if (response.stop_reason === "refusal") {
      throw new Error(
        `the model declined the request (${response.stop_details?.category ?? "no category"})`,
      );
    }
    if (response.stop_reason === "max_tokens" || !response.parsed_output) {
      throw new Error(
        "the model's answer was cut off or did not match the schema; try a smaller --chunk-size",
      );
    }
    const { kept, ignored } = keep(
      items.map((item) => item.key),
      response.parsed_output.translations,
    );
    if (ignored > 0) options.log?.(`${locale}: ignored ${ignored} answers for keys not asked for`);
    return kept;
  };
}

/** One chunk of a batch: its locale, its keys, and what goes with them. */
export type BatchChunk = {
  locale: TranslatedLocale;
  items: TranslationItem[];
  context: TranslationContext;
};

/** What each request of a batch asked for, by custom_id: kept to check the answers against. */
export type BatchRequests = Record<string, { locale: TranslatedLocale; keys: string[] }>;

const customId = (locale: TranslatedLocale, index: number): string =>
  `${locale}-${String(index).padStart(4, "0")}`;

/**
 * Batch mode: every chunk in one Message Batch, at half the price of sync
 * requests and with results within 24 hours. Returns the batch id and what
 * each request asked for, which the caller keeps until it collects.
 */
export async function submitBatch(
  chunks: readonly BatchChunk[],
  options: TranslatorOptions = {},
): Promise<{ id: string; requests: BatchRequests }> {
  const client = options.client ?? new Anthropic();
  const requests: BatchRequests = {};
  const batch = await client.messages.batches.create({
    requests: chunks.map((chunk, index) => {
      const id = customId(chunk.locale, index);
      requests[id] = { locale: chunk.locale, keys: chunk.items.map((item) => item.key) };
      return {
        custom_id: id,
        params: requestOf(chunk.locale, chunk.items, chunk.context),
      };
    }),
  });
  return { id: batch.id, requests };
}

export type BatchState = {
  ended: boolean;
  counts: Anthropic.Messages.MessageBatchRequestCounts;
};

export async function batchState(id: string, options: TranslatorOptions = {}): Promise<BatchState> {
  const client = options.client ?? new Anthropic();
  const batch = await client.messages.batches.retrieve(id);
  return { ended: batch.processing_status === "ended", counts: batch.request_counts };
}

export type BatchOutcome = {
  /** Per locale, only keys the answering request asked for. */
  translations: Record<TranslatedLocale, Record<string, string>>;
  /** Requests that returned nothing usable, by custom_id, with the reason. */
  failed: Record<string, string>;
  /** Answers for keys their request did not ask for, or from requests this batch did not send. */
  ignored: number;
  usage: Usage;
};

/** Reads an ended batch's results against what each of its requests asked for. */
export async function collectBatch(
  id: string,
  requests: BatchRequests,
  options: TranslatorOptions = {},
): Promise<BatchOutcome> {
  const client = options.client ?? new Anthropic();
  const outcome: BatchOutcome = {
    translations: { fi: {}, sv: {} },
    failed: {},
    ignored: 0,
    usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  };
  for await (const entry of await client.messages.batches.results(id)) {
    const request = Object.hasOwn(requests, entry.custom_id)
      ? requests[entry.custom_id]
      : undefined;
    if (!request) {
      outcome.ignored += 1;
      continue;
    }
    if (entry.result.type !== "succeeded") {
      outcome.failed[entry.custom_id] = entry.result.type;
      continue;
    }
    const message = entry.result.message;
    const usage = usageOf(message.usage);
    for (const field of Object.keys(usage) as (keyof Usage)[]) outcome.usage[field] += usage[field];
    if (message.stop_reason === "refusal" || message.stop_reason === "max_tokens") {
      outcome.failed[entry.custom_id] =
        message.stop_reason === "refusal" ? "the model declined the request" : "cut off";
      continue;
    }
    const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
    let parsed: z.infer<typeof Output>;
    try {
      parsed = Output.parse(JSON.parse(text.join("")));
    } catch {
      outcome.failed[entry.custom_id] = "the answer did not match the schema";
      continue;
    }
    const { kept, ignored } = keep(request.keys, parsed.translations);
    outcome.ignored += ignored;
    Object.assign(outcome.translations[request.locale], kept);
  }
  return outcome;
}
