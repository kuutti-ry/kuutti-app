import { transaction } from "@kuutti/db";
import {
  type ContactKind,
  type ConversationContacts,
  type ConversationDetail,
  elapsedBand,
  messageCountBand,
  normaliseContact,
  type StoredContact,
  type StoredContacts,
} from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import { track } from "../research/index.ts";
import { type ChatDeps, readConversation, requireConversation } from "./conversations.ts";
import * as repo from "./repo.ts";

// Contacts shared in a conversation (#103, ADR-031 §11; the maintainer's
// decisions of 18/10/2026). A person keeps up to four pieces (a phone number,
// WhatsApp, Telegram, Instagram), seen by nobody, and shares one in a
// conversation with one press: the other person sees it at once, until its
// owner stops sharing it, removes or changes it, or the conversation closes.
// No agreement step, no obligation to share back. A value reaches no log
// line, error detail, event or socket frame: a refusal names the kind, the
// events say that a share began or ended and when, never what.

type Deps = Pick<ChatDeps, "db" | "logger" | "now">;

const toStored = (row: repo.ContactRow): StoredContact => ({
  kind: row.kind,
  value: row.value,
  updatedAt: row.updatedAt.toISOString(),
});

/** The caller's stored pieces, in the kinds' order. */
export async function listContacts(deps: Deps, accountId: string): Promise<StoredContacts> {
  return { contacts: (await repo.listContacts(deps.db, accountId)).map(toStored) };
}

/** The person's stored pieces for their export (ADR-007 §3). */
export async function exportContacts(
  deps: Pick<ChatDeps, "db">,
  accountId: string,
): Promise<StoredContact[]> {
  return (await repo.listContacts(deps.db, accountId)).map(toStored);
}

/**
 * Keeps a piece in the one form of its kind (normaliseContact), replacing the
 * one stored before; a changed piece that is shared shows its new value at
 * once (migration 0059 tells the conversations). Held against an erasure, so
 * a request that outlived one writes nothing.
 */
export async function keepContact(
  deps: Deps,
  input: { accountId: string; kind: ContactKind; typed: string },
): Promise<StoredContact> {
  const value = normaliseContact(input.kind, input.typed);
  // The kind, never what was typed.
  if (value === null) {
    throw new AppError(400, "contact_invalid", "Not a contact of its kind", { kind: input.kind });
  }
  const row = await transaction(deps.db, async (tx) => {
    if (!(await repo.holdLiveAccount(tx, input.accountId))) return null;
    return repo.upsertContact(tx, {
      accountId: input.accountId,
      kind: input.kind,
      value,
      at: deps.now(),
    });
  });
  if (!row) throw new AppError(404, "not_found", "No live account");
  return toStored(row);
}

/**
 * Removes a piece and ends its standing shares, in one transaction. The
 * account is held first, as the keep and the share hold it: an erasure holds
 * it for update, ends the shares in its close and then deletes the pieces,
 * so a removal that took the piece before the shares would wait for the
 * erasure while it waited for the removal (ADR-031 §11). Held first, one
 * waits for the other to finish, and a removal that outlived an erasure
 * writes nothing. Then the piece, whose row a share in flight holds, so the
 * shares ended next include the one it begins. Each share ended is the
 * owner's event.
 */
export async function removeContact(
  deps: Deps,
  input: { accountId: string; kind: ContactKind },
): Promise<void> {
  const at = deps.now();
  const ended = await transaction(deps.db, async (tx) => {
    if (!(await repo.holdLiveAccount(tx, input.accountId))) return null;
    await repo.deleteContact(tx, input);
    return repo.endShares(tx, { ...input, how: "removed", at });
  });
  if (ended === null) throw new AppError(404, "not_found", "No live account");
  for (let i = 0; i < ended; i++) await unshared(deps, input.accountId, at);
}

/**
 * The conversation's contacts alone, by the detail's own read (ADR-031 §11):
 * what the phone reads on a `contacts` frame and on a resume. It signs no
 * thumb and writes nothing, so the other person's presses spend nothing of
 * the reader's day. 404 as the detail answers it.
 */
export async function readContacts(
  deps: Pick<ChatDeps, "db">,
  accountId: string,
  conversationId: string,
): Promise<ConversationContacts> {
  await requireConversation(deps.db, accountId, conversationId);
  return repo.readConversationContacts(deps.db, accountId, conversationId);
}

type ShareOutcome =
  | { kind: "not_found" }
  | { kind: "closed" }
  | { kind: "not_stored" }
  | { kind: "standing" }
  | { kind: "began"; openedAt: Date; messages: number };

/**
 * Shares the caller's piece of that kind in the conversation, in the send's
 * order (ADR-031 §3): the account held, the conversation's row locked, what
 * the share decides on read afresh, so a block, a close or an erasure that
 * committed meanwhile refuses it; then the piece held, so a removal in
 * flight ends what this begins. A share standing already writes nothing. A
 * share brings an archived conversation back, as a message does (TD-13).
 * The caller's fresh view is the answer.
 */
export async function shareContact(
  deps: ChatDeps,
  input: { accountId: string; conversationId: string; kind: ContactKind },
): Promise<ConversationDetail> {
  const at = deps.now();
  const outcome = await transaction(deps.db, async (tx): Promise<ShareOutcome> => {
    if (!(await repo.holdLiveAccount(tx, input.accountId))) return { kind: "not_found" };
    if (!(await repo.lockConversation(tx, input.accountId, input.conversationId))) {
      return { kind: "not_found" };
    }
    const state = await repo.readSendState(tx, input.accountId, input.conversationId);
    if (!state || state.hidden) return { kind: "not_found" };
    if (state.closed) return { kind: "closed" };
    if (!(await repo.holdContact(tx, input.accountId, input.kind))) return { kind: "not_stored" };
    if (!(await repo.beginShare(tx, { ...input, at }))) return { kind: "standing" };
    await repo.leaveArchive(tx, input.accountId, input.conversationId);
    return { kind: "began", openedAt: state.openedAt, messages: state.messages };
  });
  switch (outcome.kind) {
    case "not_found":
      throw new AppError(404, "not_found", "No such conversation");
    case "closed":
      throw new AppError(409, "conversation_closed", "The conversation is closed");
    case "not_stored":
      throw new AppError(409, "contact_not_stored", "No contact of this kind is kept", {
        kind: input.kind,
      });
    case "standing":
      break;
    case "began":
      await track(
        { db: deps.db, logger: deps.logger, now: () => at },
        input.accountId,
        "contact_shared",
        {
          sinceOpened: elapsedBand(at.getTime() - outcome.openedAt.getTime()),
          messages: messageCountBand(outcome.messages),
        },
      );
      break;
  }
  return readConversation(deps, input.accountId, input.conversationId);
}

/**
 * Stops sharing the caller's piece of that kind in the conversation. Nothing
 * standing answers with the view unchanged; a closed conversation is not
 * refused, since its close ended every share already.
 */
export async function stopSharing(
  deps: ChatDeps,
  input: { accountId: string; conversationId: string; kind: ContactKind },
): Promise<ConversationDetail> {
  const at = deps.now();
  await requireConversation(deps.db, input.accountId, input.conversationId);
  if ((await repo.endShares(deps.db, { ...input, how: "stopped", at })) > 0) {
    await unshared(deps, input.accountId, at);
  }
  return readConversation(deps, input.accountId, input.conversationId);
}

/** The owner took a share back: nothing of the kind or the value (#103). */
async function unshared(deps: Deps, accountId: string, at: Date): Promise<void> {
  await track(
    { db: deps.db, logger: deps.logger, now: () => at },
    accountId,
    "contact_unshared",
    {},
  );
}
