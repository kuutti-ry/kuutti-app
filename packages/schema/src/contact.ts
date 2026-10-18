import { z } from "zod";

/**
 * Contacts a person keeps and shares in a conversation (#103, ADR-031 §11;
 * the maintainer's decision of 18/10/2026): a phone number, WhatsApp (a
 * number), Telegram and Instagram (a username). A piece is stored first,
 * seen by nobody, and shown to the other person of a conversation only while
 * its owner shares it there. Messages and profiles refuse contact details
 * (contactDetailsIn); this is the one way through.
 */
export const CONTACT_KINDS = ["phone", "whatsapp", "telegram", "instagram"] as const;
export const ContactKind = z.enum(CONTACT_KINDS).meta({ id: "ContactKind" });
export type ContactKind = z.infer<typeof ContactKind>;

/** What may be typed for one: a number with spaces and a prefix, or a pasted username with its @. */
export const CONTACT_INPUT_MAX = 64;

const PHONE = /^\+[1-9]\d{6,14}$/;
const TELEGRAM = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const INSTAGRAM = /^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$/;

/**
 * The one form a piece is stored and shown in, or null when what was typed
 * is not one of its kind. The API and the app run the same check.
 * - A phone number and WhatsApp: E.164. Spaces, hyphens, dots and brackets
 *   go; a Finnish number from 0 becomes +358, an international one from 00
 *   becomes +, and the trunk 0 written after +358 ("+358 (0)40", "+358 040")
 *   goes, which no dialled number keeps.
 * - Telegram: the username without its @, 5 to 32 letters, digits and
 *   underscores, starting with a letter (Telegram's rule).
 * - Instagram: the username without its @, in lower case (Instagram reads
 *   it so), 1 to 30 letters, digits, dots and underscores, never a dot first,
 *   last or twice in a row (Instagram's rule).
 */
export function normaliseContact(kind: ContactKind, input: string): string | null {
  const raw = input.normalize("NFKC").trim();
  if (raw.length === 0 || raw.length > CONTACT_INPUT_MAX) return null;
  switch (kind) {
    case "phone":
    case "whatsapp": {
      let number = raw.replace(/[\s().-]/g, "");
      if (number.startsWith("00")) number = `+${number.slice(2)}`;
      else if (number.startsWith("0")) number = `+358${number.slice(1)}`;
      if (number.startsWith("+3580")) number = `+358${number.slice(5)}`;
      return PHONE.test(number) ? number : null;
    }
    case "telegram": {
      const name = raw.replace(/^@/, "");
      return TELEGRAM.test(name) ? name : null;
    }
    case "instagram": {
      const name = raw.replace(/^@/, "").toLowerCase();
      return INSTAGRAM.test(name) ? name : null;
    }
  }
}

/** One stored piece, as its owner reads it. */
export const StoredContact = z
  .object({
    kind: ContactKind,
    value: z.string().max(CONTACT_INPUT_MAX),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: "StoredContact" });
export type StoredContact = z.infer<typeof StoredContact>;

export const StoredContacts = z
  .object({ contacts: z.array(StoredContact).max(CONTACT_KINDS.length) })
  .meta({ id: "StoredContacts" });
export type StoredContacts = z.infer<typeof StoredContacts>;

export const ContactKindParams = z.object({ kind: ContactKind }).strict();

/** A piece to keep; the route checks it against its kind (normaliseContact) and answers `contact_invalid`. */
export const PutContactRequest = z
  .object({ value: z.string().min(1).max(CONTACT_INPUT_MAX) })
  .strict()
  .meta({ id: "PutContactRequest" });
export type PutContactRequest = z.infer<typeof PutContactRequest>;

/** How a share ended: its owner stopped it, the stored piece was removed, or the conversation closed. */
export const ContactShareEnd = z
  .enum(["stopped", "removed", "closed"])
  .meta({ id: "ContactShareEnd" });
export type ContactShareEnd = z.infer<typeof ContactShareEnd>;

/**
 * The contacts of one conversation for the caller (#103), in the detail
 * only, never the list: the caller's stored pieces, each with whether it is
 * shared here now, and what the other person shares with them now. Share is
 * offered only where `mine` is not empty and the conversation is open.
 */
export const ConversationContacts = z
  .object({
    mine: z
      .array(
        z.object({
          kind: ContactKind,
          value: z.string().max(CONTACT_INPUT_MAX),
          shared: z.boolean(),
        }),
      )
      .max(CONTACT_KINDS.length),
    theirs: z
      .array(z.object({ kind: ContactKind, value: z.string().max(CONTACT_INPUT_MAX) }))
      .max(CONTACT_KINDS.length),
  })
  .meta({ id: "ConversationContacts" });
export type ConversationContacts = z.infer<typeof ConversationContacts>;

/** One of the person's own shares in their export (ADR-007): the record, never the value. */
export const ExportedContactShare = z
  .object({
    kind: ContactKind,
    sharedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    endedHow: ContactShareEnd.nullable(),
  })
  .meta({ id: "ExportedContactShare" });
export type ExportedContactShare = z.infer<typeof ExportedContactShare>;
