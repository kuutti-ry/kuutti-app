import { formatDate, type PlainMessageKey } from "@kuutti/i18n";
import type {
  DealBreakerField,
  Relaxation,
  RoundChoice,
  RoundEntry,
  RoundResponse,
} from "@kuutti/schema";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { ApiError } from "@/lib/api";
import {
  decide,
  fetchRound,
  fetchYourTurn,
  relaxToday,
  reportSeen,
  undoRelaxation,
} from "./client";

type RoundView =
  | { status: "loading" }
  /** `error` says why, for the screen to say so (LoadFailed). */
  | { status: "failed"; error: unknown }
  /**
   * The day's cards are used up (ADR-034 Open 7), where the panel has set a
   * budget (ADR-062 §9): said in words, nothing to try again.
   */
  | { status: "budget" }
  /** The cards the phone holds; with none left to decide, the queue's end, or null entries before matching opens. */
  | { status: "ready"; round: RoundResponse };

/**
 * The queue past the cards the phone holds (ADR-062 §1): the next read still to
 * be asked, a read on its way or what became of it, or the end one found.
 */
type More = { status: "ask" } | { status: "end" } | Exclude<RoundView, { status: "ready" }>;

/**
 * What the screen says above the card, once, after something the person did
 * not see coming: a sentence of the catalogue, or the your-turn refusal
 * (ADR-062 §5), which says how many conversations wait.
 */
export type RoundNotice =
  | Extract<
      PlainMessageKey,
      | "errors.round_expired"
      | "errors.match_made"
      | "errors.like_budget_exceeded"
      | "errors.fish_budget_exceeded"
      | "errors.already_relaxed"
      | "errors.relaxations_changed"
      | "errors.card_budget_exceeded"
      | "round.short.nobody"
      | "round.short.failed"
      | "round.gone"
      | "round.decision.failed"
      | "round.newDay"
    >
  | { waiting: number };

/** The card on the screen, with the day its round is of. */
export type RoundCard = { day: string; entry: RoundEntry };

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : undefined);
const statusOf = (error: unknown) => (error instanceof ApiError ? error.status : undefined);

/** The Finnish day of an instant, only ever compared: a round is Finland's day (ADR-034). */
const finnishDay = (at: Date | number) => formatDate("fi", at, { timeZone: "Europe/Helsinki" });

/** Each place once, in order, the later copy winning: a read's answer is the newer word on a card. */
const byPosition = (entries: readonly RoundEntry[]): RoundEntry[] =>
  [...new Map(entries.map((entry) => [entry.position, entry])).values()].sort(
    (a, b) => a.position - b.position,
  );

/**
 * The queue on the phone (#379, #502, ADR-034, ADR-062): one card at a time,
 * the first one not yet decided, and once none is left the next read, whose
 * cards come after those the phone holds, so that Undo's last card stays. A
 * read that finds nobody is the queue's end, and nothing else is. A decision is
 * a button, dimmed while one is on its way, so nothing repeats. The last
 * decision can be taken back (ADR-034 §5): Undo brings its card back, and the
 * decision stands until another one replaces it. A like that made a match is
 * final (ADR-038 §3), so nothing offers it back. Each card reports itself seen
 * once. Whether a fish can go today, how many likes are left and how many
 * conversations wait come with each read and with every decision's answer
 * (#475, #524, ADR-062 §5), never from a read of the queue of their own (ADR-008);
 * a like refused over the conversations waiting asks the list, which hands over
 * no card.
 *
 * A day that ended while the screen was open is read anew: the API refuses
 * the old day's writes (409 `round_expired`), and the screen says why it
 * shows other cards; so is a queue that comes back in sight on another day,
 * and one whose next read finds another day. An answer to the old day's
 * request that lands after that changes nothing of the new day. A card that is
 * gone meanwhile (404) leaves the screen.
 */
export function useRound() {
  // The cards the phone holds, of one day; null until a read answers.
  const [round, setRound] = useState<RoundResponse | null>(null);
  const [more, setMore] = useState<More>({ status: "loading" });
  // A card brought back by Undo, by its place; null while the round goes on in order.
  const [revisit, setRevisit] = useState<number | null>(null);
  // The place of the last decision that Undo may bring back.
  const [last, setLast] = useState<number | null>(null);
  // The conversation a like just opened (#100).
  const [match, setMatch] = useState<string | null>(null);
  const [notice, setNotice] = useState<RoundNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const seen = useRef(new Set<string>());
  const mounted = useRef(true);
  // The round on the screen as the last answer left it (null while none is),
  // and the phone's Finnish day when it was read. An answer looks here when
  // it lands, not at the round its request went from: one to another day's
  // request (a new day was read meanwhile) changes and says nothing.
  const shown = useRef<RoundResponse | null>(null);
  const readOn = useRef<string | null>(null);
  // Of two reads under way the later one speaks.
  const asked = useRef(0);

  const showRound = useCallback((round: RoundResponse) => {
    shown.current = round;
    setRound(round);
  }, []);

  /** What belongs to the day on the screen goes, and `said` takes its place above the card. */
  const leaveDay = useCallback((said: RoundNotice | null) => {
    setRevisit(null);
    setLast(null);
    setMatch(null);
    setNotice(said);
  }, []);

  /**
   * The next cards (ADR-062 §1), kept after those of the same day the phone
   * holds. An answer of another day takes their place and says so: the day
   * ended between the last card and this read. One with nothing undecided in
   * it ends the queue, so that no answer can bring on another read by itself.
   */
  const readCards = useCallback(() => {
    asked.current += 1;
    const mine = asked.current;
    setMore({ status: "loading" });
    fetchRound().then(
      (answer) => {
        if (mine !== asked.current) return;
        readOn.current = finnishDay(Date.now());
        const held = shown.current;
        if (held && held.day !== answer.day) leaveDay("round.newDay");
        const kept = held?.day === answer.day ? held.entries : null;
        showRound({
          ...answer,
          entries: answer.entries && byPosition([...(kept ?? []), ...answer.entries]),
        });
        setMore({
          status: answer.entries?.some((entry) => entry.decision === null) ? "ask" : "end",
        });
      },
      (error: unknown) => {
        if (mine !== asked.current) return;
        setMore(
          codeOf(error) === "card_budget_exceeded"
            ? { status: "budget" }
            : { status: "failed", error },
        );
      },
    );
  }, [showRound, leaveDay]);

  // Never after the screen is gone: a read serves the cards again (ADR-008).
  const read = useCallback(
    (said: RoundNotice | null) => {
      if (!mounted.current) return;
      shown.current = null;
      setRound(null);
      leaveDay(said);
      readCards();
    },
    [leaveDay, readCards],
  );

  useEffect(() => {
    mounted.current = true;
    read(null);
    return () => {
      mounted.current = false;
    };
  }, [read]);

  /** The round on the screen while it is `day`'s; null once another day was read. */
  const onDay = useCallback((day: string) => {
    const round = shown.current;
    return round?.day === day ? round : null;
  }, []);

  /** Rewrites the entries of the round on the screen, which has the card answered. */
  const rewrite = useCallback(
    (round: RoundResponse, change: (entries: RoundEntry[]) => RoundEntry[]) =>
      showRound({ ...round, entries: round.entries && change(round.entries) }),
    [showRound],
  );

  /**
   * A card gone meanwhile, or blocked or reported from the card (ADR-030
   * §11): it leaves the screen, when its day's round is still there. It is
   * the card on the screen, so never the last decision's, which Undo would
   * bring back.
   */
  const drop = useCallback(
    (day: string, position: number) => {
      const round = onDay(day);
      if (!round) return;
      rewrite(round, (entries) => entries.filter((entry) => entry.position !== position));
      setRevisit((was) => (was === position ? null : was));
    },
    [onDay, rewrite],
  );

  /**
   * A queue left open past midnight is read anew when it comes back in sight
   * on another Finnish day (#379): nothing on one that has ended or not opened
   * asks the API, which would refuse the old day. Never on its own day, nor on
   * the phone's day it was read on, whatever the phone's clock says: each read
   * serves the cards again (ADR-008). On its own day the queue's end asks once
   * more when the person comes back to the screen, since a change of filters or
   * home works on the next read (ADR-062 §8) and the way into What you seek leads
   * back here. The app coming back asks nothing: a notification pulled down would
   * take the end and its offers away, with a loading line in their place.
   */
  const freshen = useCallback(
    (backOnScreen: boolean) => {
      const round = shown.current;
      const today = finnishDay(Date.now());
      if (
        round &&
        today !== finnishDay(new Date(`${round.day}T12:00:00Z`)) &&
        today !== readOn.current
      ) {
        read("round.newDay");
      } else if (backOnScreen) {
        setMore((was) => (was.status === "end" ? { status: "ask" } : was));
      }
    },
    [read],
  );

  // In sight: the app in the foreground, and no conversation pushed over the
  // round, under which a new day's card would be reported seen unseen.
  useFocusEffect(
    useCallback(() => {
      freshen(true);
      const subscription = AppState.addEventListener("change", (next) => {
        if (next === "active") freshen(false);
      });
      return () => subscription.remove();
    }, [freshen]),
  );

  const entry =
    round?.entries?.find((each) =>
      revisit === null ? each.decision === null : each.position === revisit,
    ) ?? null;
  const current: RoundCard | null = round && entry ? { day: round.day, entry } : null;

  // The card on the screen, reported once (ADR-034 §2); not while a match
  // stands in front of it. The report gates nothing, so a failure is not
  // said, except what it tells about the card or the day.
  const day = round?.day;
  const position = match === null ? entry?.position : undefined;
  useEffect(() => {
    if (day === undefined || position === undefined) return;
    const key = `${day}/${position}`;
    if (seen.current.has(key)) return;
    seen.current.add(key);
    reportSeen(day, position).catch((error: unknown) => {
      if (statusOf(error) === 404) drop(day, position);
      else if (codeOf(error) === "round_expired" && onDay(day)) read("round.newDay");
    });
  }, [day, position, read, drop, onDay]);

  // No card left to decide and no end found: the next read. A match stands in
  // front of it as it stands in front of a seen report, and a read hands cards
  // over (ADR-008), so it waits until the match is closed.
  const ask = !!round?.entries && !current && match === null && more.status === "ask";
  useEffect(() => {
    if (ask) readCards();
  }, [ask, readCards]);

  // The cards while one is left, or a match in front of them. Past the last
  // one the read of the next speaks, and only its empty answer is the end.
  const view: RoundView =
    round && (current || match !== null || !round.entries || more.status === "end")
      ? { status: "ready", round }
      : more.status === "ask" || more.status === "end"
        ? { status: "loading" }
        : more;

  const choose = useCallback(
    async ({ day, entry }: RoundCard, decision: RoundChoice) => {
      const { position } = entry;
      const decided = (round: RoundResponse, as: RoundChoice) =>
        rewrite(round, (entries) =>
          entries.map((each) => (each.position === position ? { ...each, decision: as } : each)),
        );
      setBusy(true);
      setNotice(null);
      try {
        const answer = await decide(day, position, decision);
        const round = onDay(day);
        if (!round) return;
        const { fishToSend, likesLeft, yourTurn } = answer;
        decided({ ...round, fishToSend, likesLeft, yourTurn }, decision);
        setRevisit(null);
        setLast(answer.match ? null : position);
        setMatch(answer.match?.conversationId ?? null);
      } catch (error) {
        // Nothing to say of another day's card: the new round was read already.
        const round = onDay(day);
        if (!round) return;
        const code = codeOf(error);
        if (code === "round_expired") {
          read("errors.round_expired");
        } else if (code === "match_made") {
          // The like stands, as it was, and the round goes on to the next card (ADR-038 §3).
          decided(round, entry.decision ?? "like");
          setRevisit(null);
          setLast(null);
          setNotice("errors.match_made");
        } else if (statusOf(error) === 404) {
          drop(day, position);
          setNotice("round.gone");
        } else if (code === "like_budget_exceeded") {
          // Another phone spent the day's last like meanwhile (#524): the line says so too.
          showRound({ ...round, likesLeft: 0 });
          setNotice("errors.like_budget_exceeded");
        } else if (code === "fish_budget_exceeded") {
          // Another phone sent the week's fish meanwhile (#475): the fish leaves the bar.
          showRound({ ...round, fishToSend: false });
          setNotice("errors.fish_budget_exceeded");
        } else if (code === "your_turn_limit") {
          // Nothing was saved: the card stays, for a pass or Later (ADR-062 §5). The
          // refusal carries no number, and the one held may be hours old, so the list
          // says how many wait now; a read that fails leaves the number held.
          const now = await fetchYourTurn().catch(() => null);
          const held = onDay(day);
          if (!held) return;
          const waiting = now ?? held.yourTurn;
          showRound({ ...held, yourTurn: waiting });
          setNotice({ waiting });
        } else {
          setNotice("round.decision.failed");
        }
      } finally {
        setBusy(false);
      }
    },
    [rewrite, onDay, read, drop, showRound],
  );

  /**
   * A deal-breaker relaxed for today (#99, ADR-042 §5): the first cards it
   * added come after the last, without a read (each read serves its cards,
   * ADR-008), and the first of them is the next on the screen. The queue is
   * open again: the read after them goes on to the rest it lets in (ADR-062 §10).
   */
  const relax = useCallback(
    async (day: string, relaxation: Relaxation) => {
      setBusy(true);
      setNotice(null);
      try {
        const added = await relaxToday(day, relaxation);
        const round = onDay(day);
        if (!round) return;
        if (added.length === 0) {
          setNotice("round.short.nobody");
        } else {
          rewrite(round, (entries) => byPosition([...entries, ...added]));
          setMore({ status: "ask" });
        }
      } catch (error) {
        if (!onDay(day)) return;
        const code = codeOf(error);
        if (code === "round_expired") read("errors.round_expired");
        else if (code === "already_relaxed") setNotice("errors.already_relaxed");
        // Another device relaxed or undid one meanwhile: the panel reads the offers again.
        else if (code === "relaxations_changed") setNotice("errors.relaxations_changed");
        // Relaxed, its cards in the round: the day's cards ran out serving them.
        else if (code === "card_budget_exceeded") setNotice("errors.card_budget_exceeded");
        else setNotice("round.short.failed");
      } finally {
        setBusy(false);
      }
    },
    [onDay, rewrite, read],
  );

  /** Today's relaxation undone (§6): the undecided cards it brought leave the screen. */
  const unrelax = useCallback(
    async (day: string, field: DealBreakerField) => {
      setBusy(true);
      setNotice(null);
      try {
        const removed = new Set(await undoRelaxation(day, field));
        const round = onDay(day);
        if (!round) return;
        rewrite(round, (entries) => entries.filter((entry) => !removed.has(entry.position)));
      } catch (error) {
        if (!onDay(day)) return;
        if (codeOf(error) === "round_expired") read("errors.round_expired");
        else setNotice("round.short.failed");
      } finally {
        setBusy(false);
      }
    },
    [onDay, rewrite, read],
  );

  const undo = useCallback(() => {
    setRevisit(last);
    setLast(null);
    setNotice(null);
  }, [last]);

  return {
    view,
    /** A read past the cards the phone holds, not the first of the screen: what the screen says aloud. */
    readingOn: round !== null && view.status === "loading",
    /** The card on the screen: the first undecided one, or the one Undo brought back, decided already. */
    current,
    canUndo: last !== null && !busy && match === null,
    busy,
    match,
    notice,
    choose,
    undo,
    drop,
    relax,
    unrelax,
    closeMatch: useCallback(() => setMatch(null), []),
    // Past the cards the phone holds, a failed read is asked again without losing them.
    retry: useCallback(() => (shown.current ? readCards() : read(null)), [read, readCards]),
  };
}
