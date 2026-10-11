import { ApiError } from "@/lib/api";
import { saveSession } from "@/lib/session";
import { clearEmail, fetchEmail, saveEmail } from "./email-client";

// The optional e-mail's routes (#148): what each sends, what it answers, and
// a refusal as an ApiError with the envelope's code.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

function answering(...answers: Response[]) {
  const seen: Request[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.push(request);
    const answer = answers.shift();
    if (!answer) throw new Error("no answer prepared");
    return answer;
  }) as unknown as typeof fetch;
  return seen;
}

beforeEach(async () => {
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("the e-mail client", () => {
  it("reads the address, or none", async () => {
    answering(json({ email: "aino@example.test" }), json({ email: null }));
    expect(await fetchEmail()).toBe("aino@example.test");
    expect(await fetchEmail()).toBeNull();
  });

  it("fails a refused read with the code", async () => {
    answering(refusal("account_gone", 410));
    await expect(fetchEmail()).rejects.toMatchObject({
      name: "ApiError",
      status: 410,
      code: "account_gone",
      message: "email answered 410",
    });
  });

  it("saves an address and answers it back", async () => {
    const seen = answering(new Response(null, { status: 204 }));
    expect(await saveEmail("aino@example.test")).toBe("aino@example.test");
    expect(seen[0]?.method).toBe("PUT");
    expect(new URL(seen[0]?.url ?? "").pathname).toBe("/account/email");
    expect(JSON.parse(await (seen[0] as Request).text())).toEqual({ email: "aino@example.test" });
  });

  it("fails a refused save with the code, and without one when the answer is not the envelope", async () => {
    answering(refusal("validation_failed", 422), new Response("oops", { status: 500 }));
    await expect(saveEmail("not an address")).rejects.toMatchObject({
      status: 422,
      code: "validation_failed",
    });
    const error = await saveEmail("aino@example.test").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 500, code: undefined });
  });

  it("removes the address and answers none", async () => {
    const seen = answering(new Response(null, { status: 204 }));
    expect(await clearEmail()).toBeNull();
    expect(seen[0]?.method).toBe("DELETE");
  });

  it("fails a refused removal with the code", async () => {
    answering(refusal("internal_error", 500));
    await expect(clearEmail()).rejects.toMatchObject({
      status: 500,
      code: "internal_error",
      message: "email removal answered 500",
    });
  });
});
