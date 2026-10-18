import { randomUUID } from "node:crypto";
import { type Queryable, transaction } from "../pool.ts";

/**
 * The conversations of the personas' stories (#348, ADR-031): the chat's pair
 * talking for a few days, a match nobody wrote in, which the night has
 * archived (TD-13), and the contact share's pair, two days into theirs (#103). Written as rows, as the match's record: no route opens a
 * conversation until #100 writes one from the second like, and the stories
 * will then like instead. The demo commands call the writer after the
 * histories, with the accounts the histories were given to.
 *
 * The times are hours before the stories run, so the open conversation's
 * last message is a day old after any reset; a week without one and the
 * night archives it like any other.
 */
export type PersonaConversation = {
  /** Side a and side b, by persona key. */
  between: readonly [string, string];
  /** When the match opened it. */
  openedHoursAgo: number;
  /** When the night archived it, silent for `silent_match_archive_days`; absent while it is open. */
  archivedHoursAgo?: number;
  /** Oldest first; the first is sequence 1. */
  messages: readonly { from: "a" | "b"; hoursAgo: number; body: string }[];
  /** The highest sequence each side has read (`read_up_to`). */
  readUpTo: { a: number; b: number };
  /**
   * A photo sent after the messages (#350). Not written here: the API's demo
   * commands send it through the chat's own send, the pipeline and the check
   * included, from the release's pictures, with this fixed id, so a second
   * run is answered with the stored message and writes nothing.
   */
  photo?: { from: "a" | "b"; hoursAgo: number; asset: string; caption: string; clientId: string };
};

export const PERSONA_CONVERSATIONS: readonly PersonaConversation[] = [
  {
    // The chat's flow (`chat-text`): Antti has not read Ville's last message,
    // and Ville has read all of Antti's, so Antti sees "Read" under his own.
    between: ["antti", "ville"],
    openedHoursAgo: 100,
    messages: [
      {
        from: "a",
        hoursAgo: 98,
        body: "Hei Ville! Purjehdus ja avantouinti samassa profiilissa. Kumpi tuli ensin?",
      },
      {
        from: "b",
        hoursAgo: 96,
        body: "Moi Antti! Purjehdus. Avanto tuli, kun en malttanut odottaa kesää.",
      },
      {
        from: "a",
        hoursAgo: 75,
        body: "Ymmärrän. Minä odotan kesää pullan kanssa, se on helpompaa.",
      },
      { from: "b", hoursAgo: 72, body: "Pullasta en kieltäydy koskaan. Millaista leivot?" },
      {
        from: "a",
        hoursAgo: 50,
        body: "Kardemummapullaa, ja korvapuusteja, jos on aikaa. Tulisitko maistamaan?",
      },
      { from: "b", hoursAgo: 20, body: "Tulen mielelläni. Sopisiko lauantai?" },
    ],
    readUpTo: { a: 5, b: 5 },
    // Ville's view of the lake, the seventh message: his own, so his unread
    // count stays as `chat-text` reads it; Antti has not opened it yet.
    photo: {
      from: "b",
      hoursAgo: 19,
      asset: "negatives/no-face.jpg",
      caption: "Tällainen ilta järvellä. Lauantaina kuulemma samanlainen sää.",
      clientId: "7b1d3a52-0c9e-4f6a-9d2b-5e8c1f4a6b30",
    },
  },
  {
    // Matched ten days ago, and nobody wrote: Antti's archived group.
    between: ["antti", "sanna"],
    openedHoursAgo: 240,
    archivedHoursAgo: 70,
    messages: [],
    readUpTo: { a: 0, b: 0 },
  },
  {
    // The contact share's flow (#103): open, everything read on both sides,
    // and Elina's last line says what she does next, from the header. The
    // words carry no way to reach either of them, as the send would refuse.
    between: ["elina", "jussi"],
    openedHoursAgo: 60,
    messages: [
      {
        from: "a",
        hoursAgo: 58,
        body: "Hei Jussi! Lukupiiri kuulostaa hyvältä. Mitä siellä luetaan nyt?",
      },
      {
        from: "b",
        hoursAgo: 55,
        body: "Moi Elina! Pohjoismaisia dekkareita, joissa sataa koko ajan.",
      },
      {
        from: "a",
        hoursAgo: 30,
        body: "Ne ovat minun bussikirjojani. Pääsisikö piiriin vieraaksi?",
      },
      {
        from: "b",
        hoursAgo: 26,
        body: "Pääsee. Sovitaan päivä, kun tiedän ensi viikon menot.",
      },
      {
        from: "a",
        hoursAgo: 6,
        body: "Hyvä. Jaan sinulle yhteystietoni täältä, niin sovitaan loput siellä.",
      },
    ],
    readUpTo: { a: 4, b: 5 },
  },
];

const HOUR_MS = 60 * 60 * 1000;

/** `missing`: a persona of the conversation has no account this time (spared as staff, or refused). */
export type ConversationsResult = { written: number; already: number; missing: number };

/**
 * Writes each conversation between the accounts the stories gave its two
 * personas, by key. One told before, between the same two accounts, is left
 * as it is: on staging the stories job runs again without a reset and
 * changes nothing (ADR-018 §5).
 */
export async function writeConversations(
  db: Queryable,
  accounts: ReadonlyMap<string, string>,
  now: Date,
): Promise<ConversationsResult> {
  const result: ConversationsResult = { written: 0, already: 0, missing: 0 };
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * HOUR_MS);
  for (const told of PERSONA_CONVERSATIONS) {
    const a = accounts.get(told.between[0]);
    const b = accounts.get(told.between[1]);
    if (!a || !b) {
      result.missing += 1;
      continue;
    }
    const written = await transaction(db, async (tx) => {
      const before = await tx.query(
        `SELECT 1 FROM conversation_participant p
         JOIN conversation_participant q ON q.conversation_id = p.conversation_id AND q.side <> p.side
         WHERE p.account_id = $1 AND q.account_id = $2`,
        [a, b],
      );
      if (before.rowCount) return false;
      const opened = hoursAgo(told.openedHoursAgo);
      const last = told.messages.at(-1);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO conversation (opened_at, last_message_at, next_seq, archived_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [
          opened,
          last ? hoursAgo(last.hoursAgo) : null,
          told.messages.length + 1,
          told.archivedHoursAgo === undefined ? null : hoursAgo(told.archivedHoursAgo),
        ],
      );
      const id = rows[0]?.id;
      await tx.query(
        `INSERT INTO conversation_participant (conversation_id, account_id, side, read_up_to, joined_at)
         VALUES ($1, $2, 'a', $4, $6), ($1, $3, 'b', $5, $6)`,
        [id, a, b, told.readUpTo.a, told.readUpTo.b, opened],
      );
      for (const [i, message] of told.messages.entries()) {
        await tx.query(
          `INSERT INTO message (conversation_id, seq, side, client_id, kind, body, created_at)
           VALUES ($1, $2, $3, $4, 'text', $5, $6)`,
          [id, i + 1, message.from, randomUUID(), message.body, hoursAgo(message.hoursAgo)],
        );
      }
      return true;
    });
    if (written) result.written += 1;
    else result.already += 1;
  }
  return result;
}
