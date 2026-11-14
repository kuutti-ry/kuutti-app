import { describe, expect, it } from "vitest";
import { attackWith } from "../../../../scripts/lib/attack.ts";
import { createApp } from "../app.ts";
import { signedInAccount, signInAs, staffSession } from "./account.ts";
import { errorCode } from "./answers.ts";
import { conversationBetween } from "./chat.ts";
import { captureLogger, jsonHeaders, testConfig } from "./harness.ts";
import { testMediaDeps } from "./media.ts";
import { people } from "./people.ts";
import { rolledBack } from "./rolled-back.ts";

// Rule 6, ADR-031 and ADR-006: a real session, real rows, and the same route
// with the right caller as its control. A 400, 500 or missing route is a
// broken attempt, never evidence that the ownership or role guard held.
const attack = attackWith(it);
const AT = new Date("2026-10-16T09:00:00.000Z");
const CLIENT_ID = "00000000-0000-4000-8000-000000000380";

async function admitted(response: Response, success: number, refusal = 404, code = "not_found") {
  if (response.status === success) return true;
  expect(response.status).toBe(refusal);
  expect(await errorCode(response)).toBe(code);
  return false;
}

const conversationCases = [
  { name: "read its detail", method: "GET", tail: "", success: 200 },
  { name: "read its messages", method: "GET", tail: "/messages", success: 200 },
  {
    name: "send a message",
    method: "POST",
    tail: "/messages",
    success: 201,
    body: { clientId: CLIENT_ID, body: "A message from the route's caller." },
  },
  { name: "move its read mark", method: "POST", tail: "/read", success: 204, body: { upTo: 1 } },
  { name: "read its shared contacts", method: "GET", tail: "/contacts", success: 200 },
  { name: "share a contact", method: "POST", tail: "/contacts/phone", success: 200 },
  { name: "stop a contact share", method: "DELETE", tail: "/contacts/phone", success: 200 },
  { name: "end it", method: "POST", tail: "/unmatch", success: 204 },
  { name: "block its counterpart", method: "POST", tail: "/block", success: 204 },
  {
    name: "report its counterpart",
    method: "POST",
    tail: "/report",
    success: 204,
    body: { reason: "other" },
  },
] as const;

describe("route ownership attacks against another person's conversation", () => {
  for (const row of conversationCases) {
    const run = (owner: boolean) =>
      rolledBack(async (db) => {
        const ids = await people(db, null, 3, { complete: true, registeredAt: AT });
        const [a, b, outsider] = ids;
        if (!a || !b || !outsider) throw new Error("conversation people not written");
        const conversationId = await conversationBetween(db, a, b, {
          openedAt: new Date(AT.getTime() - 3_600_000),
          messages: [{ from: "b", body: "A message already in the conversation." }],
        });
        const caller = await signInAs(db, owner ? a : outsider);
        const { logger } = await captureLogger();
        const { deps: media } = await testMediaDeps();
        const app = createApp({ db, logger, media, config: testConfig(), now: () => AT });
        // Both callers have a valid stored contact: a missing contact cannot
        // stand in for the participant check on the sharing routes.
        const kept = await app.request("/contacts/phone", {
          method: "PUT",
          headers: jsonHeaders(caller.headers),
          body: JSON.stringify({ value: "+358401234567" }),
        });
        expect(kept.status).toBe(200);
        const response = await app.request(`/conversations/${conversationId}${row.tail}`, {
          method: row.method,
          headers: jsonHeaders(caller.headers),
          ...("body" in row ? { body: JSON.stringify(row.body) } : {}),
        });
        return admitted(response, row.success);
      });
    attack(`a nonparticipant can ${row.name}`, {
      attempt: () => run(false),
      control: () => run(true),
      succeeds: (seen) => expect(seen).toBe(true),
    });
  }
});

const photoCases = ["thumb", "card", "full", "delete", "caption", "order"] as const;
describe("route ownership attacks against another person's photos", () => {
  for (const operation of photoCases) {
    const run = (owner: boolean) =>
      rolledBack(async (db) => {
        const ids = await people(db, null, 2, { complete: true });
        const [subject, outsider] = ids;
        if (!subject || !outsider) throw new Error("photo people not written");
        const photos = await db.query<{ id: string }>(
          "SELECT id FROM photo WHERE account_id = $1 ORDER BY position",
          [subject],
        );
        const photoId = photos.rows[0]?.id;
        if (!photoId) throw new Error("photo not written");
        const caller = await signInAs(db, owner ? subject : outsider);
        const { logger } = await captureLogger();
        const { deps: media } = await testMediaDeps();
        const app = createApp({ db, logger, media, config: testConfig(), now: () => AT });
        const tail = operation === "delete" ? "" : `/${operation}`;
        const path = operation === "order" ? "/photos/order" : `/photos/${photoId}${tail}`;
        const body =
          operation === "caption"
            ? { caption: "ask_me" }
            : operation === "order"
              ? { order: photos.rows.map((photo) => photo.id) }
              : undefined;
        const response = await app.request(path, {
          method: operation === "delete" ? "DELETE" : body ? "PUT" : "GET",
          headers: jsonHeaders(caller.headers),
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return admitted(
          response,
          operation === "delete" ? 204 : 200,
          operation === "order" ? 400 : 404,
          operation === "order" ? "photo_order_invalid" : "not_found",
        );
      });
    attack(`a stranger can use the photo ${operation} route`, {
      attempt: () => run(false),
      control: () => run(true),
      succeeds: (seen) => expect(seen).toBe(true),
    });
  }
});

const staffCases = [
  { path: "/admin/photos/queue", role: "moderator" },
  { path: "/admin/reports", role: "moderator" },
  { path: "/admin/overview", role: "moderator" },
  { path: "/admin/staff", role: "admin" },
] as const;
describe("route role attacks against staff-only reads", () => {
  for (const row of staffCases) {
    for (const intruder of ["product", "researcher"] as const) {
      const run = (authorized: boolean) =>
        rolledBack(async (db) => {
          const caller = authorized
            ? await staffSession(db, row.role)
            : intruder === "product"
              ? await signedInAccount(db)
              : await staffSession(db, "researcher");
          const { logger } = await captureLogger();
          const app = createApp({ db, logger, config: testConfig(), now: () => AT });
          const response = await app.request(row.path, { headers: caller.headers });
          return admitted(
            response,
            200,
            intruder === "product" ? 401 : 403,
            intruder === "product" ? "unauthenticated" : "admin_forbidden",
          );
        });
      attack(`${intruder} credentials read ${row.path}`, {
        attempt: () => run(false),
        control: () => run(true),
        succeeds: (seen) => expect(seen).toBe(true),
      });
    }
  }
});
