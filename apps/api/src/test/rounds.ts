import { randomUUID } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import {
  type DistanceBand,
  type RoundDecision,
  RoundDecisionAnswer,
  type RoundReason,
} from "@kuutti/schema";
import { expect } from "vitest";
import { type App, createApp } from "../app.ts";
import {
  conversationsOnTurn,
  openConversation,
  conversationBetween as standing,
} from "../chat/index.ts";
import { fitsNow } from "../jobs/round-builder.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { addPlaces, type Queue } from "../matching/index.ts";
import { signInAs } from "./account.ts";
import { conversationBetween } from "./chat.ts";
import { STOPPED_CLOCK } from "./global-setup.ts";
import { captureLogger, testConfig } from "./harness.ts";
import { type PeopleOptions, people, pondNamed } from "./people.ts";
import { FITTING } from "./queue.ts";

/**
 * The day's log as a test writes it (#502, ADR-062): earlier days, whatever the
 * queue would have put there, and what `decide` is handed. Through the queue's
 * one writer and plain SQL for the rest: what a card went through on an ended
 * day has no route, since the routes refuse an ended day.
 */

/** A day's card: somebody, matching every filter unless it says otherwise. */
export type LoggedCard =
  | string
  | {
      candidateId: string;
      reason: RoundReason;
      distance?: DistanceBand;
      /** On a `relaxed` card: the day's relaxations it came in under. */
      relaxedWith?: readonly string[];
    };

/**
 * `count` people who all fit each other, in a pond of their own nobody has
 * opened: a read asks them the filters (ADR-062 §8) and serves what a test wrote
 * into their logs, and adds nobody. People of two calls never fit each other.
 */
export async function peopleWhoFit(
  db: Queryable,
  count: number,
  options: PeopleOptions = {},
): Promise<string[]> {
  return people(db, await pondNamed(db, `test-fit-${randomUUID()}`), count, {
    ...FITTING,
    ...options,
  });
}

/**
 * These cards at the next places of the person's log of `day`, which this opens
 * if it is not open yet, as a day's first read would (`addPlaces`); its id. Noon
 * or so in Finland is when it says it was written.
 */
export async function logged(
  db: Queryable,
  accountId: string,
  day: string,
  cards: readonly LoggedCard[],
): Promise<string> {
  const written = await addPlaces(
    {
      db,
      logger: (await captureLogger()).logger,
      now: () => new Date(`${day}T09:00:00.000Z`),
    },
    {
      accountId,
      day,
      places: cards.map((card) =>
        typeof card === "string"
          ? { candidateId: card, reason: "matches_filters", distance: "nearby" }
          : { distance: "nearby", ...card },
      ),
    },
  );
  if (written === null) throw new Error("nobody's log to write");
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM rounds WHERE account_id = $1 AND day = $2",
    [accountId, day],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no round written");
  return id;
}

/**
 * `owner` was shown `candidate` at `at` and decided as said. `displayed` false is
 * an entry queued and never displayed, which showed nobody (ADR-062 §2); left at
 * its default a card with no decision is one displayed and left. The entry's id.
 */
export async function shownAt(
  db: Queryable,
  at: Date,
  owner: string,
  candidate: string,
  decision: RoundDecision | null,
  options: { displayed?: boolean; fish?: boolean; secondPass?: boolean } = {},
): Promise<string> {
  const roundId = await logged(db, owner, finnishDay(at), [candidate]);
  const { rows } = await db.query<{ id: string }>(
    `UPDATE round_entries
        SET seen_at = $3, decision = $4, decided_at = $5, fish = $6, second_pass = $7
      WHERE round_id = $1 AND candidate_id = $2
      RETURNING id`,
    [
      roundId,
      candidate,
      (options.displayed ?? true) ? at : null,
      decision,
      decision ? at : null,
      options.fish ?? false,
      options.secondPass ?? false,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("card not written");
  return id;
}

/** A conversation of the two that the silence put away at `at`, or that one of them closed then. Its id. */
export async function endedConversation(
  db: Queryable,
  first: string,
  second: string,
  at: Date,
  how: "closed" | "archived",
): Promise<string> {
  const id = await conversationBetween(db, first, second, {
    openedAt: new Date(at.getTime() - 8 * 24 * 3600 * 1000),
    ...(how === "archived" ? { archivedAt: at } : {}),
  });
  if (how === "closed") {
    await db.query(
      "UPDATE conversation SET closed_at = $2, closed_how = 'unmatch', closed_by = 'a' WHERE id = $1",
      [id, at],
    );
  }
  return id;
}

/** `count` matches nobody has said anything in, each on the person's turn (ADR-062 §5), with people of this pond; those people. */
export async function conversationsWaiting(
  db: Queryable,
  pondId: string,
  accountId: string,
  count: number,
): Promise<string[]> {
  const others = await people(db, pondId, count, FITTING);
  for (const other of others) {
    await conversationBetween(db, accountId, other, { openedAt: new Date("2026-01-01") });
  }
  return others;
}

/** The pond a person is in. */
export async function pondOfPerson(db: Queryable, accountId: string): Promise<string> {
  const { rows } = await db.query<{ pond_id: string | null }>(
    "SELECT pond_id FROM account WHERE id = $1",
    [accountId],
  );
  const pond = rows[0]?.pond_id;
  if (!pond) throw new Error("nobody in a pond");
  return pond;
}

/** What `decide` is handed of the chat slice, as app.ts hands it. */
export const MATCHES = {
  between: standing,
  open: openConversation,
  yourTurn: conversationsOnTurn,
};

/** What `decide` reads across slices at a clock, as app.ts hands it. */
export const fitsAt = (now: () => Date): Pick<Queue, "fits"> => ({
  fits: (db, accountId, candidateIds) => fitsNow({ now }, db, accountId, candidateIds),
});

/** `count` people who fit one another, each signed in. */
export async function cast(db: Queryable, count: number) {
  const ids = await peopleWhoFit(db, count);
  return Promise.all(ids.map((id) => signInAs(db, id)));
}

/** A block from one person to the other, written straight into the table by their identities. */
export async function block(
  db: Queryable,
  blocker: { accountId: string },
  blocked: { accountId: string },
) {
  await db.query(
    `INSERT INTO block (blocker_identity_id, blocked_identity_id)
     SELECT x.identity_id, y.identity_id FROM account x, account y WHERE x.id = $1 AND y.id = $2`,
    [blocker.accountId, blocked.accountId],
  );
}

/** The fish left to send, from a decision's answer. */
export async function fishToSendAfter(answer: Response) {
  expect(answer.status).toBe(200);
  return RoundDecisionAnswer.parse(await answer.json()).fishToSend;
}

/** The likes left, from a decision's answer. */
export async function likesLeftAfter(answer: Response) {
  expect(answer.status).toBe(200);
  return RoundDecisionAnswer.parse(await answer.json()).likesLeft;
}

/** An app on the test's connection whose clock stands at `at`. */
export async function appAt(db: Queryable, at: Date = STOPPED_CLOCK): Promise<App> {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db, now: () => at });
}
