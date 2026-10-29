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
import { decide, fetchRound, relaxToday, reportSeen, undoRelaxation } from "./client";

export type RoundView =
  | { status: "loading" }
  /** `error` says why, for the screen to say so (LoadFailed). */
  | { status: "failed"; error: unknown }
  /** The day's cards are used up (ADR-034 Open 7): said in words, nothing to try again. */
  | { status: "budget" }
  | { status: "ready"; round: RoundResponse };

/** What the screen says above the round, once, after something the person did not see coming. */
export type RoundNotice = Extract<
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
>;

/** The card on the screen, with the day its round is of. */
export type RoundCard = { day: string; entry: RoundEntry };

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : undefined);
const statusOf = (error: unknown) => (error instanceof ApiError ? error.status : undefined);

/** The Finnish day of an instant, only ever compared: a round is Finland's day (ADR-034). */
const finnishDay = (at: Date | number) => formatDate("fi", at, { timeZone: "Europe/Helsinki" });

/**
 * Today's round on the phone (#379, ADR-034): read once, then one card at a
 * time, the first one not yet decided. A decision is a button, dimmed while
 * one is on its way, so nothing repeats. The last decision can be taken back
 * (ADR-034 §5): Undo brings its card back, and the decision stands until
 * another one replaces it. A like that made a match is final (ADR-038 §3),
 * so nothing offers it back. Each card reports itself seen once. Whether a
 * fish can go today comes with the round and with every decision's answer
 * (#475), never from a read of its own (ADR-008).
 *
 * A day that ended while the screen was open is read anew: the API refuses
 * the old day's writes (409 `round_expired`), and the screen says why it
 * shows other cards; a round with nothing left to ask the API is read anew
 * when it comes back in sight on another day. An answer to the old day's
 * request that lands after that changes nothing of the new round. A card
 * that is gone meanwhile (404) leaves the screen.
 */
export function useRound() {
  const [view, setView] = useState<RoundView>({ status: "loading" });
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

  const showRound = useCallback((round: RoundResponse) => {
    shown.current = round;
    setView({ status: "ready", round });
  }, []);

  // Never after the screen is gone: a read serves the cards again (ADR-008).
  const read = useCallback(
    (said: RoundNotice | null) => {
      if (!mounted.current) return;
      shown.current = null;
      setView({ status: "loading" });
      setRevisit(null);
      setLast(null);
      setMatch(null);
      setNotice(said);
      fetchRound()
        .then((round) => {
          readOn.current = finnishDay(Date.now());
          showRound(round);
        })
        .catch((error: unknown) =>
          setView(
            codeOf(error) === "card_budget_exceeded"
              ? { status: "budget" }
              : { status: "failed", error },
          ),
        );
    },
    [showRound],
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
   * A round left open past midnight is read anew when it comes back in sight
   * on another Finnish day (#379): nothing on a finished, empty or unbuilt
   * round asks the API, which would refuse the old day. Never on its own day,
   * nor on the phone's day it was read on, whatever the phone's clock says:
   * each read serves the cards again (ADR-008).
   */
  const freshen = useCallback(() => {
    const round = shown.current;
    const today = finnishDay(Date.now());
    if (
      round &&
      today !== finnishDay(new Date(`${round.day}T12:00:00Z`)) &&
      today !== readOn.current
    ) {
      read("round.newDay");
    }
  }, [read]);

  // In sight: the app in the foreground, and no conversation pushed over the
  // round, under which a new day's card would be reported seen unseen.
  useFocusEffect(
    useCallback(() => {
      freshen();
      const subscription = AppState.addEventListener("change", (next) => {
        if (next === "active") freshen();
      });
      return () => subscription.remove();
    }, [freshen]),
  );

  const round = view.status === "ready" ? view.round : null;
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
        decided({ ...round, fishToSend: answer.fishToSend }, decision);
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
          setNotice("errors.like_budget_exceeded");
        } else if (code === "fish_budget_exceeded") {
          // Another phone sent the week's fish meanwhile (#475): the fish leaves the bar.
          showRound({ ...round, fishToSend: false });
          setNotice("errors.fish_budget_exceeded");
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
   * A deal-breaker relaxed for today (#99, ADR-042 §5): the cards it added
   * come after the last, without reading the round again (each read serves
   * every card, ADR-008), and the first of them is the next on the screen.
   */
  const relax = useCallback(
    async (day: string, relaxation: Relaxation) => {
      setBusy(true);
      setNotice(null);
      try {
        const added = await relaxToday(day, relaxation);
        const round = onDay(day);
        if (!round) return;
        if (added.length === 0) setNotice("round.short.nobody");
        else rewrite(round, (entries) => [...entries, ...added]);
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
    retry: useCallback(() => read(null), [read]),
  };
}
