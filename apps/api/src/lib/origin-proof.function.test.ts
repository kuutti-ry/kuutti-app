import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

// The CloudFront Function that proves Kuutti's distribution to the box
// (ADR-066, infra/modules/media/origin-proof.js), run here as CloudFront runs
// it: a context of its own, no Node and no module system. The `cloudfront`
// module's kvs() is given in place of the import, and the store's id is filled
// in as OpenTofu's templatefile() fills it. What must hold above all is that a
// viewer's own x-kuutti-origin never passes, a filled store or not.

type Header = { value: string; multiValue?: { value: string }[] };
type Request = { method: string; uri: string; headers: Record<string, Header> };
type Handler = (event: { request: Request }) => Promise<Request>;

const STORE_ID = "11111111-2222-3333-4444-555555555555";
const VALUE = "origin-proof-of-the-test-4711-4711-4711";
const FORGED = "a value the viewer chose";
// biome-ignore lint/suspicious/noTemplateCurlyInString: the template's own placeholder, which templatefile() fills in
const PLACEHOLDER = "${store_id}";

const template = readFileSync(
  new URL("../../../../infra/modules/media/origin-proof.js", import.meta.url),
  "utf8",
);

/** The function with a store whose reads answer `read`, and the ids it opened. */
function functionWith(read: (key: string) => Promise<string>, storeId = STORE_ID) {
  const opened: string[] = [];
  const source = template
    .replace(/^import cf from "cloudfront";$/m, "")
    .replace(PLACEHOLDER, storeId);
  const context = createContext({
    cf: {
      kvs: (id: string) => {
        opened.push(id);
        // CloudFront reads only the store associated with the function.
        return {
          get: (key: string) =>
            id === STORE_ID ? read(key) : Promise.reject(new Error("no such store")),
        };
      },
    },
  });
  runInContext(source, context);
  return { handler: context.handler as Handler, opened };
}

const filled = (key: string) =>
  key === "origin-secret" ? Promise.resolve(VALUE) : Promise.reject(new Error("Key not found"));
const empty = () => Promise.reject(new Error("Key not found"));

function request(headers: Record<string, Header> = {}): { request: Request } {
  return {
    request: {
      method: "GET",
      uri: "/health",
      headers: { host: { value: "api.staging.kuutti.app" }, ...headers },
    },
  };
}

describe("the origin-proof CloudFront Function (ADR-066)", () => {
  it("contains the placeholder templatefile() fills, once, and no other template directive", () => {
    expect(template.split(PLACEHOLDER)).toHaveLength(2);
    expect(template).not.toContain("%{");
  });

  it("opens the store OpenTofu named and reads its one key", async () => {
    const reads: string[] = [];
    const { handler, opened } = functionWith((key) => {
      reads.push(key);
      return Promise.resolve(VALUE);
    });
    await handler(request());
    expect(opened).toEqual([STORE_ID]);
    expect(reads).toEqual(["origin-secret"]);
  });

  it("from a filled store sends the store's value, and nothing of what the viewer sent", async () => {
    const { handler } = functionWith(filled);
    expect((await handler(request())).headers["x-kuutti-origin"]).toEqual({ value: VALUE });
    const forged = await handler(request({ "x-kuutti-origin": { value: FORGED } }));
    expect(forged.headers["x-kuutti-origin"]).toEqual({ value: VALUE });
    const twice = await handler(
      request({
        "x-kuutti-origin": {
          value: FORGED,
          multiValue: [{ value: FORGED }, { value: "a second" }],
        },
      }),
    );
    expect(twice.headers["x-kuutti-origin"]).toEqual({ value: VALUE });
  });

  it.each([
    ["a store without the key", empty],
    ["a read that fails", () => Promise.reject(new Error("throttled"))],
  ])("with %s sends no proof at all, and removes the viewer's own", async (_, read) => {
    const { handler } = functionWith(read);
    const answered = await handler(request({ "x-kuutti-origin": { value: FORGED } }));
    expect(answered.headers).not.toHaveProperty("x-kuutti-origin");
    expect((await handler(request())).headers).not.toHaveProperty("x-kuutti-origin");
  });

  it("with a store id other than the store's sends no proof", async () => {
    const { handler } = functionWith(filled, "99999999-0000-0000-0000-000000000000");
    const answered = await handler(request({ "x-kuutti-origin": { value: FORGED } }));
    expect(answered.headers).not.toHaveProperty("x-kuutti-origin");
  });

  it("leaves every other header, the method and the path as the viewer sent them", async () => {
    const { handler } = functionWith(filled);
    const answered = await handler(request({ cookie: { value: "session=abc" } }));
    expect(answered.method).toBe("GET");
    expect(answered.uri).toBe("/health");
    expect(answered.headers.host).toEqual({ value: "api.staging.kuutti.app" });
    expect(answered.headers.cookie).toEqual({ value: "session=abc" });
  });
});
