import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  anthropicTranslator,
  type BatchRequests,
  collectBatch,
  MODEL,
  submitBatch,
} from "./anthropic-translator.ts";
import type { TranslationContext, TranslationItem } from "./translate.ts";

// A stand-in for the API client: no network and no key in tests (CLAUDE.md
// Testing). It records every request, so the tests can say what leaves the
// machine.
type Recorded = Record<string, unknown>;

const usage = {
  input_tokens: 900,
  output_tokens: 120,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 1500,
};

function fakeClient(answer: Partial<Recorded> = {}) {
  const requests: Recorded[] = [];
  const batches: Recorded[] = [];
  const message = (text: string, stop_reason = "end_turn") => ({
    stop_reason,
    usage,
    content: [{ type: "text", text }],
  });
  const client = {
    beta: {
      messages: {
        parse: async (params: Recorded) => {
          requests.push(params);
          return {
            model: MODEL,
            stop_reason: "end_turn",
            stop_details: null,
            usage,
            parsed_output: {
              translations: [
                { key: "demo.hello", text: "Hei" },
                { key: "demo.save", text: "Tallenna" },
              ],
            },
            ...answer,
          };
        },
      },
    },
    messages: {
      batches: {
        create: async (params: Recorded) => {
          batches.push(params);
          return { id: "msgbatch_test" };
        },
        retrieve: async () => ({ processing_status: "ended", request_counts: {} }),
        results: async () =>
          (async function* () {
            const answer = (translations: { key: string; text: string }[]) =>
              message(JSON.stringify({ translations }));
            yield {
              custom_id: "fi-0000",
              result: {
                type: "succeeded",
                // demo.bio was never asked of this request: it must not come back.
                message: answer([
                  { key: "demo.hello", text: "Hei" },
                  { key: "demo.bio", text: "Kerro itsestäsi" },
                ]),
              },
            };
            yield { custom_id: "fi-0001", result: { type: "errored", error: {} } };
            yield {
              custom_id: "sv-0002",
              result: { type: "succeeded", message: message("not json") },
            };
            yield {
              custom_id: "sv-0003",
              result: { type: "succeeded", message: message("", "refusal") },
            };
            yield {
              custom_id: "fi-9999",
              result: { type: "succeeded", message: answer([{ key: "demo.save", text: "x" }]) },
            };
          })(),
      },
    },
  };
  return { client: client as unknown as Anthropic, requests, batches };
}

const items: TranslationItem[] = [
  { key: "demo.hello", en: "Hello", description: "Greeting." },
  { key: "demo.save", en: "Save", description: "A button.", max_length: 12 },
];
const context: TranslationContext = {
  glossary: "Kuutti: never translated",
  tone: "Plain and warm.",
  examples: [{ en: "Thanks", text: "Kiitos" }],
};

describe("the Anthropic translator", () => {
  it("sends message text, the glossary, the tone guide and examples, and nothing else", async () => {
    const { client, requests } = fakeClient();
    await anthropicTranslator({ client })("fi", items, context);
    const [request] = requests;
    expect(Object.keys(request ?? {}).sort()).toEqual(
      [
        "betas",
        "fallbacks",
        "max_tokens",
        "messages",
        "model",
        "output_config",
        "system",
        "thinking",
      ].sort(),
    );
    const messages = request?.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(1);
    const sent = JSON.parse(messages[0]?.content ?? "");
    expect(Object.keys(sent).sort()).toEqual(["examples", "items"]);
    expect(sent.items).toEqual(items);
    expect(sent.examples).toEqual(context.examples);
  });

  it("asks for high effort and the server-side fallback, and marks the tone guide and glossary for the cache", async () => {
    const { client, requests } = fakeClient();
    await anthropicTranslator({ client })("fi", items, context);
    const [request] = requests;
    expect(request).toMatchObject({
      model: "claude-opus-5-5",
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    });
    const system = request?.system as { text: string; cache_control?: unknown }[];
    expect(system[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(system[1]?.text).toContain("Plain and warm.");
    expect(system[1]?.text).toContain("Kuutti: never translated");
  });

  it("returns the translations and logs the usage, naming the model a fallback went to", async () => {
    const lines: string[] = [];
    const { client } = fakeClient({
      model: "claude-opus-4-8",
      usage: { ...usage, iterations: [{ type: "message" }, { type: "fallback_message" }] },
    });
    const result = await anthropicTranslator({ client, log: (line) => lines.push(line) })(
      "fi",
      items,
      context,
    );
    expect(result).toEqual({ "demo.hello": "Hei", "demo.save": "Tallenna" });
    expect(lines).toEqual([
      "fi: 2 keys, 900 input, 1500 cache read, 0 cache write, 120 output tokens, answered by claude-opus-4-8 (fallback)",
    ]);
  });

  it("keeps only the keys it asked for, each once", async () => {
    const lines: string[] = [];
    const { client } = fakeClient({
      parsed_output: {
        translations: [
          { key: "demo.hello", text: "Hei" },
          { key: "demo.hello", text: "Moi" },
          { key: "profile.bio", text: "Kerro itsestäsi" },
          { key: "__proto__", text: "x" },
        ],
      },
    });
    const result = await anthropicTranslator({ client, log: (line) => lines.push(line) })(
      "fi",
      items,
      context,
    );
    expect(result).toEqual({ "demo.hello": "Hei" });
    expect(lines[1]).toBe("fi: ignored 3 answers for keys not asked for");
  });

  it("throws on a refusal or a cut-off answer, so the run reports that chunk and goes on", async () => {
    const refused = fakeClient({ stop_reason: "refusal", stop_details: { category: "cyber" } });
    await expect(
      anthropicTranslator({ client: refused.client })("fi", items, context),
    ).rejects.toThrow(/declined the request \(cyber\)/);
    const cut = fakeClient({ stop_reason: "max_tokens", parsed_output: null });
    await expect(anthropicTranslator({ client: cut.client })("fi", items, context)).rejects.toThrow(
      /cut off/,
    );
  });
});

describe("batch mode", () => {
  it("submits one request per chunk and returns what each asked for, without the fallback the Batches API refuses", async () => {
    const { client, batches } = fakeClient();
    const { id, requests } = await submitBatch(
      [
        { locale: "fi", items, context },
        { locale: "sv", items: [items[0] as TranslationItem], context },
      ],
      { client },
    );
    expect(id).toBe("msgbatch_test");
    expect(requests).toEqual({
      "fi-0000": { locale: "fi", keys: ["demo.hello", "demo.save"] },
      "sv-0001": { locale: "sv", keys: ["demo.hello"] },
    });
    const sent = (batches[0]?.requests ?? []) as { custom_id: string; params: Recorded }[];
    expect(sent.map((r) => r.custom_id)).toEqual(["fi-0000", "sv-0001"]);
    for (const { params } of sent) {
      expect(params).not.toHaveProperty("fallbacks");
      expect(params).not.toHaveProperty("betas");
      expect(params).toMatchObject({
        model: MODEL,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
      });
    }
  });

  it("reads results back against what each request asked for, and names every request that failed", async () => {
    const { client } = fakeClient();
    const asked: BatchRequests = {
      "fi-0000": { locale: "fi", keys: ["demo.hello"] },
      "fi-0001": { locale: "fi", keys: ["demo.save"] },
      "sv-0002": { locale: "sv", keys: ["demo.hello"] },
      "sv-0003": { locale: "sv", keys: ["demo.save"] },
    };
    const outcome = await collectBatch("msgbatch_test", asked, { client });
    expect(outcome.translations).toEqual({ fi: { "demo.hello": "Hei" }, sv: {} });
    expect(outcome.failed).toEqual({
      "fi-0001": "errored",
      "sv-0002": "the answer did not match the schema",
      "sv-0003": "the model declined the request",
    });
    // demo.bio, never asked of fi-0000, and fi-9999, a request this batch never sent.
    expect(outcome.ignored).toBe(2);
    // Three answered requests of this batch were billed, whatever came of them.
    expect(outcome.usage).toEqual({ input: 2700, output: 360, cacheWrite: 0, cacheRead: 4500 });
  });
});
