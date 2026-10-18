import { saveSession } from "@/lib/session";
import { blockConversation, blockPerson, reportConversation, reportPerson } from "./client";

// The block and report routes as the app calls them (#84, ADR-030): what each
// sends, with the session, and a refusal as an ApiError with the envelope's
// code, or with none when the answer is no envelope.

const SUBJECT = "0c2d2d5f-0b9f-4b1b-8d4b-1d9e2f3a4b5c";
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const refusal = (code: string, status: number) =>
  new Response(JSON.stringify({ error: { code, message: "x", requestId: "r" } }), {
    status,
    headers: { "content-type": "application/json" },
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
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("the safety client", () => {
  it("blocks with the account id alone, under the session, and fails a refusal with its code", async () => {
    const seen = answering(new Response(null, { status: 204 }), refusal("not_found", 404));
    await expect(blockPerson(SUBJECT)).resolves.toBeUndefined();
    expect(seen[0]?.method).toBe("POST");
    expect(new URL(seen[0]?.url ?? "").pathname).toBe("/blocks");
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${token("access")}`);
    expect(await seen[0]?.json()).toEqual({ accountId: SUBJECT });
    await expect(blockPerson(SUBJECT)).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      code: "not_found",
      message: "block answered 404",
    });
  });

  it("reports with the reason and the note as given, and fails the day's cap with its code", async () => {
    const seen = answering(
      new Response(null, { status: 204 }),
      refusal("report_budget_exceeded", 429),
    );
    const body = { accountId: SUBJECT, reason: "harassment" as const, note: "Kept messaging." };
    await expect(reportPerson(body)).resolves.toBeUndefined();
    expect(new URL(seen[0]?.url ?? "").pathname).toBe("/reports");
    expect(await seen[0]?.json()).toEqual(body);
    await expect(reportPerson(body)).rejects.toMatchObject({
      status: 429,
      code: "report_budget_exceeded",
      message: "report answered 429",
    });
  });

  it("blocks and reports from a conversation by its id, the report with the reason and the note alone (#351)", async () => {
    const seen = answering(
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
      refusal("report_window_closed", 409),
    );
    await expect(blockConversation(SUBJECT)).resolves.toBeUndefined();
    expect(seen[0]?.method).toBe("POST");
    expect(new URL(seen[0]?.url ?? "").pathname).toBe(`/conversations/${SUBJECT}/block`);
    const body = { reason: "other" as const, note: "Kysyi rahaa." };
    await expect(reportConversation(SUBJECT, body)).resolves.toBeUndefined();
    expect(new URL(seen[1]?.url ?? "").pathname).toBe(`/conversations/${SUBJECT}/report`);
    expect(await seen[1]?.json()).toEqual(body);
    await expect(reportConversation(SUBJECT, body)).rejects.toMatchObject({
      status: 409,
      code: "report_window_closed",
      message: "report answered 409",
    });
  });

  it("fails a block from a conversation with its code", async () => {
    answering(refusal("not_found", 404));
    await expect(blockConversation(SUBJECT)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
      message: "block answered 404",
    });
  });

  it("fails an answer that is no envelope without a code", async () => {
    answering(new Response("Bad Gateway", { status: 502 }));
    await expect(reportPerson({ accountId: SUBJECT, reason: "other" })).rejects.toMatchObject({
      status: 502,
      code: undefined,
    });
  });
});
