import { ApiError } from "@/lib/api";
import { saveSession } from "@/lib/session";
import { clearEmail, confirmEmailCode, fetchEmail, saveEmail, sendEmailCode } from "./email-client";

// The optional e-mail's routes (#148, #385): what each sends, what it
// answers, and a refusal as an ApiError with the envelope's code.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const none = { email: null, confirmed: false, codeExpiresAt: null };
const unconfirmed = { email: "aino@example.test", confirmed: false, codeExpiresAt: null };
const waiting = { ...unconfirmed, codeExpiresAt: "2030-01-01T00:30:00.000Z" };
const confirmed = { email: "aino@example.test", confirmed: true, codeExpiresAt: null };
const sent = async (request: Request | undefined) => ({
  method: request?.method,
  path: new URL(request?.url ?? "").pathname,
  body: request?.body ? JSON.parse(await request.text()) : undefined,
});

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
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("the e-mail client", () => {
  it("reads the address with its confirmation, or none", async () => {
    const seen = answering(json(waiting), json(confirmed), json(none));
    expect(await fetchEmail()).toEqual(waiting);
    expect(await fetchEmail()).toEqual(confirmed);
    expect(await fetchEmail()).toEqual(none);
    expect(await sent(seen[0])).toEqual({ method: "GET", path: "/account/email", body: undefined });
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

  it("refuses an answer that is not the contract, an older API's bare address", async () => {
    answering(json({ email: "aino@example.test" }));
    await expect(fetchEmail()).rejects.toMatchObject({ name: "ZodError" });
  });

  it("saves an address and answers the state the API keeps, unconfirmed", async () => {
    const seen = answering(json(unconfirmed));
    expect(await saveEmail("aino@example.test")).toEqual(unconfirmed);
    expect(await sent(seen[0])).toEqual({
      method: "PUT",
      path: "/account/email",
      body: { email: "aino@example.test" },
    });
  });

  it("fails a refused save with the code, and without one when the answer is not the envelope", async () => {
    answering(refusal("validation_failed", 400), new Response("oops", { status: 500 }));
    await expect(saveEmail("not an address")).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
      message: "email save answered 400",
    });
    const error = await saveEmail("aino@example.test").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 500, code: undefined });
  });

  it("removes the address and answers none, though the API answers no body", async () => {
    const seen = answering(new Response(null, { status: 204 }));
    expect(await clearEmail()).toEqual(none);
    expect(await sent(seen[0])).toEqual({
      method: "DELETE",
      path: "/account/email",
      body: undefined,
    });
  });

  it("fails a refused removal with the code", async () => {
    answering(refusal("internal_error", 500));
    await expect(clearEmail()).rejects.toMatchObject({
      status: 500,
      code: "internal_error",
      message: "email removal answered 500",
    });
  });

  it("asks for a code and answers until when it works", async () => {
    const seen = answering(json(waiting));
    expect(await sendEmailCode()).toEqual(waiting);
    expect(await sent(seen[0])).toEqual({
      method: "POST",
      path: "/account/email/code",
      body: undefined,
    });
  });

  it("fails a refused send with the code: the day's codes, no mail, confirmed already", async () => {
    answering(
      refusal("email_code_budget_exceeded", 429),
      refusal("mail_unavailable", 503),
      refusal("email_confirmed", 409),
    );
    await expect(sendEmailCode()).rejects.toMatchObject({
      name: "ApiError",
      status: 429,
      code: "email_code_budget_exceeded",
      message: "email code answered 429",
    });
    await expect(sendEmailCode()).rejects.toMatchObject({ status: 503, code: "mail_unavailable" });
    await expect(sendEmailCode()).rejects.toMatchObject({ status: 409, code: "email_confirmed" });
  });

  it("confirms with the code and answers the address confirmed", async () => {
    const seen = answering(json(confirmed));
    expect(await confirmEmailCode("012345")).toEqual(confirmed);
    expect(await sent(seen[0])).toEqual({
      method: "POST",
      path: "/account/email/confirm",
      body: { code: "012345" },
    });
  });

  it("fails a refused confirmation with the code, and without one when the answer is not the envelope", async () => {
    answering(refusal("email_code_wrong", 400), new Response("oops", { status: 502 }));
    await expect(confirmEmailCode("000000")).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      code: "email_code_wrong",
      message: "email confirmation answered 400",
    });
    await expect(confirmEmailCode("000000")).rejects.toMatchObject({
      status: 502,
      code: undefined,
    });
  });
});
