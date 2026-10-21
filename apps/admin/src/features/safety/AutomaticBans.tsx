import { formatDateTime, type TFunction } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import { type AutomaticBan, AutomaticBanQueue, type SanctionRule } from "@kuutti/schema";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { isLate, useAge } from "../../lib/age.ts";
import { api } from "../../lib/api.ts";
import { ScreenTitle } from "../../lib/screen-title.tsx";
import { useList } from "../../lib/use-list.ts";
import { ReviewStep } from "./Sanctions.tsx";

// The automatic shadow bans (#105, ADR-033; #86's velocity, ADR-041): the
// shadow bans a rule applied on its own, oldest first, each waiting for a moderator to confirm or reverse
// it. A line says the rule in counts and times only, never a message or a
// reporter, which is all the API sends; how long the person has been hidden
// by the API's clock, and "Late" in words and weight past the review time,
// never by colour alone. Confirm and Reverse are #307's second look with the
// decision fixed by the button pressed, so the step presets nothing
// (rules/admin.md). The person's page, linked from each line, has the rest.
// English only (TD-17); keyboard first.

/** The account id as the panel shortens it elsewhere (#171). */
const short = (accountId: string) => accountId.slice(0, 8);

/** The span a rule counted over: its first event, and when it applied the ban. */
type Span = { first: string; at: string };

/** Each rule in words, from its count and its span: what the API sends, and all a moderator needs. */
const RULE: Record<SanctionRule, (t: TFunction, count: number, span: Span) => string> = {
  reports: (t, people, span) => t("admin.automaticBans.rule.reports", { people, ...span }),
  first_messages: (t, conversations, span) =>
    t("admin.automaticBans.rule.first_messages", { conversations, ...span }),
  same_first_message: (t, people, span) =>
    t("admin.automaticBans.rule.same_first_message", { people, ...span }),
  photo_fetches: (t, photos, span) =>
    t("admin.automaticBans.rule.photo_fetches", { photos, ...span }),
  cards_served: (t, people, span) =>
    t("admin.automaticBans.rule.cards_served", { people, ...span }),
  round_reads: (t, reads, span) => t("admin.automaticBans.rule.round_reads", { reads, ...span }),
};

type Decision = { ban: AutomaticBan; outcome: "keep" | "lift" };

export function AutomaticBans() {
  const { t, locale } = useT();
  const { state, reload, settle, update } = useList({
    fetchPage: () => api.GET("/admin/sanctions/automatic"),
    parse: (data) => AutomaticBanQueue.parse(data),
    what: "automatic bans",
  });
  const [step, setStep] = useState<Decision | null>(null);
  const [done, setDone] = useState<Decision | null>(null);
  const status = useRef<HTMLParagraphElement>(null);

  // A decision takes its line off the list, and the button that opened the
  // step with it: the status line says what was done and takes the focus.
  useEffect(() => {
    if (done) status.current?.focus();
  }, [done]);

  // The step names the account and what the rule counted: several people
  // share this screen, and the step is the last look before the decision.
  const fixed = ({ ban, outcome }: Decision) => {
    const account = short(ban.accountId);
    const when = (at: string) => formatDateTime(locale, new Date(at));
    const counted = RULE[ban.rule](t, ban.count, {
      first: when(ban.firstAt),
      at: when(ban.createdAt),
    });
    return outcome === "keep"
      ? {
          outcome,
          title: t("admin.automaticBans.confirmTitle", { account }),
          effect: `${counted} ${t("admin.automaticBans.confirmEffect")}`,
          submit: t("admin.automaticBans.confirm"),
        }
      : {
          outcome,
          title: t("admin.automaticBans.reverseTitle", { account }),
          effect: `${counted} ${t("admin.automaticBans.reverseEffect")}`,
          submit: t("admin.automaticBans.reverse"),
        };
  };

  return (
    <section aria-labelledby="automatic-bans-title">
      <ScreenTitle id="automatic-bans-title">{t("admin.automaticBans.title")}</ScreenTitle>
      {state.kind === "ready" && (
        <p>{t("admin.automaticBans.explain", { hours: state.reviewHours })}</p>
      )}
      <div className="row">
        {state.kind === "ready" && (
          <p aria-live="polite">
            {t("admin.automaticBans.total", { total: state.total })}
            {state.items.length < state.total && (
              <> {t("admin.automaticBans.shown", { shown: String(state.items.length) })}</>
            )}
          </p>
        )}
        <button type="button" className="apart" onClick={() => void reload()}>
          {t("admin.automaticBans.refresh")}
        </button>
      </div>
      <p ref={status} role="status" tabIndex={-1}>
        {done?.outcome === "keep" && (
          <>
            {t("admin.automaticBans.done.confirm", { account: short(done.ban.accountId) })}{" "}
            <Link className="target" to="/reports">
              {t("admin.automaticBans.reportsLink")}
            </Link>
          </>
        )}
        {done?.outcome === "lift" &&
          t("admin.automaticBans.done.reverse", { account: short(done.ban.accountId) })}
      </p>
      {state.kind === "loading" && <p aria-busy="true">{t("admin.automaticBans.loading")}</p>}
      {state.kind === "error" && <p role="alert">{t("admin.automaticBans.error")}</p>}
      {state.kind === "ready" && (
        <ul className="queue">
          {state.items.map((ban) => (
            <BanLine
              key={ban.id}
              ban={ban}
              now={state.now}
              reviewHours={state.reviewHours}
              onDecide={(outcome) => {
                // The last decision's line is cleared, so the next one is heard.
                setDone(null);
                setStep({ ban, outcome });
              }}
            />
          ))}
        </ul>
      )}
      {step && (
        <ReviewStep
          key={`${step.ban.id}-${step.outcome}`}
          item={{ id: step.ban.id, kind: "shadow_ban", liftedAt: null }}
          fixed={fixed(step)}
          onCancel={() => setStep(null)}
          onShell={() => setStep(null)}
          onDone={async () => {
            setStep(null);
            update((items) => items.filter((item) => item.id !== step.ban.id));
            settle();
            setDone(step);
          }}
        />
      )}
    </section>
  );
}

function BanLine({
  ban,
  now,
  reviewHours,
  onDecide,
}: {
  ban: AutomaticBan;
  now: string;
  reviewHours: number;
  onDecide: (outcome: Decision["outcome"]) => void;
}) {
  const { t, locale } = useT();
  const ageOf = useAge();
  const facts = useId();
  const heading = useId();
  const when = (at: string) => formatDateTime(locale, new Date(at));
  return (
    <li className="group">
      <h3 id={heading}>
        <Link className="target" to={`/accounts/${ban.accountId}`}>
          {t("admin.automaticBans.account", { account: short(ban.accountId) })}
        </Link>
      </h3>
      <p id={facts}>
        {RULE[ban.rule](t, ban.count, { first: when(ban.firstAt), at: when(ban.createdAt) })}
      </p>
      <p>
        {t("admin.automaticBans.hidden", { age: ageOf(ban.createdAt, now) })}
        {isLate(ban.createdAt, now, reviewHours) && (
          <>
            {" "}
            <strong>{t("admin.late", { hours: String(reviewHours) })}</strong>
          </>
        )}
      </p>
      {/* Each button is described by whose ban it is and what the rule counted, so a screen reader says which. */}
      <div className="actions">
        <button
          type="button"
          aria-describedby={`${heading} ${facts}`}
          onClick={() => onDecide("keep")}
        >
          {t("admin.automaticBans.confirm")}
        </button>
        <button
          type="button"
          aria-describedby={`${heading} ${facts}`}
          onClick={() => onDecide("lift")}
        >
          {t("admin.automaticBans.reverse")}
        </button>
      </div>
    </li>
  );
}
