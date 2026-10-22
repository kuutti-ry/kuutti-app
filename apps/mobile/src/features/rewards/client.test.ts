import { saveSession } from "@/lib/session";
import { fetchInvitations, makeInvitation, redeemInvitation, withdrawInvitation } from "./client";

// The invitations as the app calls them (#107, ADR-044): each route with the
// session, its answer parsed by its contract, and a refusal an ApiError with
// the status and the envelope's code.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number, code = "x") =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

const ID = "7a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";
const INVITATIONS = {
  canInvite: true,
  redeemable: false,
  reward: { fish: 1, likes: 0 },
  open: [{ id: ID, createdAt: "2026-10-22T09:00:00.000Z" }],
  counted: 2,
  earned: { fish: 1, likes: 0 },
};

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
const pathOf = (request: Request | undefined) => new URL(request?.url ?? "").pathname;

beforeEach(async () => {
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("the invitations client", () => {
  it("reads the person's invitations with the session", async () => {
    const seen = answering(json(INVITATIONS), refusal(500));
    expect(await fetchInvitations()).toEqual(INVITATIONS);
    expect(pathOf(seen[0])).toBe("/invitations");
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${token("access")}`);
    await expect(fetchInvitations()).rejects.toMatchObject({
      status: 500,
      message: "invitations answered 500",
    });
  });

  it("refuses an answer its contract does not hold, such as a code in the list", async () => {
    answering(json({ ...INVITATIONS, open: "ABCDE-FGHJK" }));
    await expect(fetchInvitations()).rejects.toThrow();
  });

  it("makes an invitation and gives its code, and a refusal carries its code", async () => {
    const made = { id: ID, code: "ABCDE-FGHJK", createdAt: "2026-10-22T09:00:00.000Z" };
    const seen = answering(json(made, 201), refusal(409, "invitations_full"));
    expect(await makeInvitation()).toEqual(made);
    expect(seen[0]?.method).toBe("POST");
    expect(pathOf(seen[0])).toBe("/invitations");
    await expect(makeInvitation()).rejects.toMatchObject({
      status: 409,
      code: "invitations_full",
      message: "invitation answered 409",
    });
  });

  it("withdraws an invitation by its id, and fails a refusal", async () => {
    const seen = answering(new Response(null, { status: 204 }), refusal(404, "not_found"));
    await expect(withdrawInvitation(ID)).resolves.toBeUndefined();
    expect(seen[0]?.method).toBe("DELETE");
    expect(pathOf(seen[0])).toBe(`/invitations/${ID}`);
    await expect(withdrawInvitation(ID)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
      message: "withdrawal answered 404",
    });
  });

  it("sends a code as typed, and a refusal carries its code; one without an envelope has none", async () => {
    const seen = answering(
      new Response(null, { status: 204 }),
      refusal(404, "invitation_unknown"),
      new Response("upstream", { status: 502 }),
    );
    await expect(redeemInvitation("abcde fghjk")).resolves.toBeUndefined();
    expect(seen[0]?.method).toBe("POST");
    expect(pathOf(seen[0])).toBe("/invitations/redeem");
    expect(JSON.parse(await (seen[0] as Request).text())).toEqual({ code: "abcde fghjk" });
    await expect(redeemInvitation("ABCDE-FGHJK")).rejects.toMatchObject({
      status: 404,
      code: "invitation_unknown",
    });
    await expect(redeemInvitation("ABCDE-FGHJK")).rejects.toMatchObject({
      status: 502,
      code: undefined,
      message: "redeem answered 502",
    });
  });
});
