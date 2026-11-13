import { act } from "@testing-library/react";
import { vi } from "vitest";

/**
 * The network of a panel attack (#380): requests answered when the test says,
 * so an answer can come late, after a newer one, or never. The pages' own
 * tests answer at once from a list of handlers; an attack needs the order.
 */

/** A JSON answer, as the API gives one. */
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The path a request went to. */
export const pathOf = (request: Request) => new URL(request.url).pathname;

/**
 * An answer the test holds back. The request waits until `answer` or `fail`;
 * with neither it waits for good, which is a server that never answers.
 */
export type Held = {
  promise: Promise<Response>;
  answer: (response: Response) => void;
  fail: (error?: Error) => void;
};
export function held(): Held {
  let answer!: (response: Response) => void;
  let fail!: (error?: Error) => void;
  const promise = new Promise<Response>((resolve, reject) => {
    answer = resolve;
    // What fetch itself rejects with when no answer comes at all: no status, no body.
    fail = (error = new TypeError("Failed to fetch")) => reject(error);
  });
  return { promise, answer, fail };
}

type Reply = Response | Promise<Response> | null;
export type Handler = (request: Request) => Reply;

/** A handler for one method and path: a string, or a pattern where the path carries an id. */
export function on(
  method: string,
  path: string | RegExp,
  reply: (request: Request) => Response | Promise<Response>,
): Handler {
  const matches = (found: string) => (typeof path === "string" ? found === path : path.test(found));
  return (request) =>
    request.method === method && matches(pathOf(request)) ? reply(request) : null;
}

/**
 * Stands in for fetch: each request goes to the first handler that takes it,
 * and one nobody takes rejects by name. Returns the requests sent, in order.
 * `vi.unstubAllGlobals()` in the file's `afterEach` takes it away.
 */
export function network(handlers: Handler[]): Request[] {
  const sent: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      sent.push(request);
      for (const handler of handlers) {
        const reply = handler(request);
        if (reply) return reply;
      }
      throw new Error(`unexpected ${request.method} ${request.url}`);
    }),
  );
  return sent;
}

/** The requests sent to one method and path. */
export const sentTo = (sent: Request[], method: string, path: string | RegExp) =>
  sent.filter(
    (request) =>
      request.method === method &&
      (typeof path === "string" ? pathOf(request) === path : path.test(pathOf(request))),
  );

/**
 * Lets everything already under way finish: effects, state changes, and any
 * request about to be sent. An attack calls it last in `attempt`, so that
 * `succeeds` looks at what happened and never waits for what did not.
 */
export const settled = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
