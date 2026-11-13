// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { held, json, network, on, pathOf, sentTo, settled } from "./network.ts";

afterEach(() => vi.unstubAllGlobals());

describe("the network of a panel attack (#380)", () => {
  it("answers a request from the first handler that takes it, and keeps what was sent", async () => {
    const sent = network([
      on("GET", "/admin/overview", () => json({ waiting: 2 })),
      on("POST", /^\/admin\/photos\/[^/]+\/decision$/, () => json({ state: "approved" }, 201)),
    ]);
    const read = await fetch("http://api.test/admin/overview?since=1");
    expect(await read.json()).toEqual({ waiting: 2 });
    const wrote = await fetch("http://api.test/admin/photos/p1/decision", { method: "POST" });
    expect(wrote.status).toBe(201);
    expect(sent.map((request) => `${request.method} ${pathOf(request)}`)).toEqual([
      "GET /admin/overview",
      "POST /admin/photos/p1/decision",
    ]);
    expect(sentTo(sent, "POST", /\/decision$/)).toHaveLength(1);
    expect(sentTo(sent, "GET", "/admin/overview")).toHaveLength(1);
    expect(sentTo(sent, "DELETE", "/admin/overview")).toHaveLength(0);
  });

  it("rejects a request nobody takes, by its method and address", async () => {
    network([on("GET", "/admin/overview", () => json({}))]);
    await expect(fetch("http://api.test/admin/staff")).rejects.toThrow(
      "unexpected GET http://api.test/admin/staff",
    );
    await expect(fetch("http://api.test/admin/overview", { method: "POST" })).rejects.toThrow(
      "unexpected POST",
    );
  });

  it("holds an answer until the test gives it, so the later request can be answered first", async () => {
    const first = held();
    const second = held();
    const answers = [first, second];
    network([on("GET", /^\/admin\/accounts\//, () => (answers.shift() as typeof first).promise)]);
    const order: string[] = [];
    const one = fetch("http://api.test/admin/accounts/a").then(async (r) =>
      order.push(await r.text()),
    );
    const two = fetch("http://api.test/admin/accounts/b").then(async (r) =>
      order.push(await r.text()),
    );
    second.answer(new Response("b"));
    await two;
    first.answer(new Response("a"));
    await one;
    expect(order).toEqual(["b", "a"]);
  });

  it("fails a held request the way fetch does when no answer comes, or with the error given", async () => {
    const lost = held();
    const refused = held();
    const answers = [lost, refused];
    network([on("GET", "/admin/staff", () => (answers.shift() as typeof lost).promise)]);
    const first = fetch("http://api.test/admin/staff");
    lost.fail();
    await expect(first).rejects.toThrow(new TypeError("Failed to fetch"));
    const second = fetch("http://api.test/admin/staff");
    refused.fail(new Error("offline"));
    await expect(second).rejects.toThrow("offline");
  });

  it("leaves a request without an answer for as long as the test gives none", async () => {
    const never = held();
    network([on("GET", "/admin/staff", () => never.promise)]);
    let done = false;
    void fetch("http://api.test/admin/staff").finally(() => {
      done = true;
    });
    await settled();
    expect(done).toBe(false);
  });

  it("lets what is under way finish before the test looks: a promise's turn, and a timer already due", async () => {
    const finished: string[] = [];
    void Promise.resolve().then(() => finished.push("a promise's turn"));
    // A request sent from an effect leaves on a later turn of the loop than the click that caused it.
    setTimeout(() => finished.push("a timer already due"), 0);
    await settled();
    expect(finished).toEqual(["a promise's turn", "a timer already due"]);
  });
});
