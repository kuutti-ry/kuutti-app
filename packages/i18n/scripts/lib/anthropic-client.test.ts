import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranslationContext, TranslationItem } from "./translate.ts";

// The translator with its default client (#13, #55): the CLI never passes one,
// so the SDK's own class is replaced here, at the client boundary. No network,
// no key: the stand-in answers from `state` and counts how often it was built.
const state = vi.hoisted(() => ({
  built: [] as unknown[],
  parse: undefined as unknown,
  retrieve: undefined as unknown,
  results: [] as unknown[],
  sent: [] as Record<string, unknown>[],
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class StandIn {
    constructor(...args: unknown[]) {
      state.built.push(args);
    }
    beta = {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          state.sent.push(params);
          return state.parse;
        },
      },
    };
    messages = {
      batches: {
        create: async () => ({ id: "msgbatch_default" }),
        retrieve: async (id: string) => ({ ...(state.retrieve as object), id }),
        results: async () =>
          (async function* () {
            yield* state.results;
          })(),
      },
    };
  },
}));

const { anthropicTranslator, batchState, collectBatch, submitBatch } = await import(
  "./anthropic-translator.ts"
);

const items: TranslationItem[] = [{ key: "demo.hello", en: "Hello", description: "Greeting." }];
const bare: TranslationContext = { glossary: "", tone: "" };

const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
};

beforeEach(() => {
  state.built.length = 0;
  state.sent.length = 0;
  state.parse = {
    model: "claude-opus-5",
    stop_reason: "end_turn",
    stop_details: null,
    usage,
    parsed_output: { translations: [{ key: "demo.hello", text: "Hei" }] },
  };
});

describe("the translator's default client", () => {
  it("is built from the environment, with nothing from the repository passed to it", async () => {
    const translate = anthropicTranslator();
    expect(state.built).toEqual([[]]);
    expect(await translate("fi", items, bare)).toEqual({ "demo.hello": "Hei" });
  });

  it("sends an empty list of examples when there are none, and counts absent cache tokens as none", async () => {
    const lines: string[] = [];
    await anthropicTranslator({ log: (line) => lines.push(line) })("sv", items, bare);
    const [message] = (state.sent[0]?.messages ?? []) as { content: string }[];
    const content = message?.content ?? "";
    expect(JSON.parse(content).examples).toEqual([]);
    expect(lines).toEqual(["sv: 1 keys, 10 input, 0 cache read, 0 cache write, 5 output tokens"]);
  });

  it("names a refusal without a category as such", async () => {
    state.parse = { ...(state.parse as object), stop_reason: "refusal", stop_details: null };
    await expect(anthropicTranslator()("fi", items, bare)).rejects.toThrow(
      "the model declined the request (no category)",
    );
  });

  it("throws on an answer off the schema even when it was not cut off", async () => {
    state.parse = { ...(state.parse as object), parsed_output: null };
    await expect(anthropicTranslator()("fi", items, bare)).rejects.toThrow(
      /did not match the schema/,
    );
  });
});

describe("a batch with the default client", () => {
  it("is submitted, asked after and collected, each through a client of its own", async () => {
    const submitted = await submitBatch([{ locale: "fi", items, context: bare }]);
    expect(submitted.id).toBe("msgbatch_default");

    state.retrieve = {
      processing_status: "in_progress",
      request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    };
    expect(await batchState("msgbatch_default")).toEqual({
      ended: false,
      counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    });
    state.retrieve = { ...(state.retrieve as object), processing_status: "ended" };
    expect((await batchState("msgbatch_default")).ended).toBe(true);

    state.results = [];
    const outcome = await collectBatch("msgbatch_default", submitted.requests);
    expect(outcome).toEqual({
      translations: { fi: {}, sv: {} },
      failed: {},
      ignored: 0,
      usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    });
    expect(state.built).toHaveLength(4);
  });

  it("names a request cut off at its token limit, and reads the text past a thinking block", async () => {
    const answer = JSON.stringify({ translations: [{ key: "demo.hello", text: "Hej" }] });
    state.results = [
      {
        custom_id: "fi-0000",
        result: {
          type: "succeeded",
          message: { stop_reason: "max_tokens", usage, content: [] },
        },
      },
      {
        custom_id: "sv-0001",
        result: {
          type: "succeeded",
          message: {
            stop_reason: "end_turn",
            usage,
            content: [
              { type: "thinking", thinking: "…" },
              { type: "text", text: answer.slice(0, 10) },
              { type: "text", text: answer.slice(10) },
            ],
          },
        },
      },
    ];
    const outcome = await collectBatch("msgbatch_default", {
      "fi-0000": { locale: "fi", keys: ["demo.hello"] },
      "sv-0001": { locale: "sv", keys: ["demo.hello"] },
    });
    expect(outcome.failed).toEqual({ "fi-0000": "cut off" });
    expect(outcome.translations).toEqual({ fi: {}, sv: { "demo.hello": "Hej" } });
    expect(outcome.usage).toEqual({ input: 20, output: 10, cacheWrite: 0, cacheRead: 0 });
  });
});
