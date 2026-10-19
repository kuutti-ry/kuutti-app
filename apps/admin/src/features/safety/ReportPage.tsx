import { formatDateTime, type PlainMessageKey } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import {
  type ReportActable,
  type ReportCopyLine,
  ReportDecision,
  type ReportDecisionRequest,
  ReportDetail,
  type Sanction,
  type SanctionKind,
} from "@kuutti/schema";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../../lib/api.ts";
import { Dialog } from "../../lib/dialog.tsx";
import { ScreenTitle } from "../../lib/screen-title.tsx";
import { usePhotoOnRequest } from "./photo-on-request.ts";
import { OUTCOME, REASON, SOURCE } from "./report-words.ts";
import { KIND_WORDS, SanctionActions } from "./Sanctions.tsx";
import { outcomeOf, type Refusals, useSend } from "./use-send.ts";

// One report, worked to a decision (#312, TD-5, ADR-030 §6, §12): its facts,
// both people linked to their pages with the queue's histories, the
// reporter's words, and for a conversation's report the copy frozen when it
// was filed, each line's side said in words and its text shown as text, a
// photo fetched only on request. Every open is an audit row on the API's side
// (conversation.view or report.view), so the page asks once per id, StrictMode
// included, and never again: after a decision it updates in place from the
// answer. The decision: a sanction applied here (#308's own actions), which
// closes the report as acted on in the same move; a sanction applied since
// the filing; or dismissed. No age and no "Late" here: the queue shows both,
// by the API's clock. A 403 is the shell's to say (#302). English only
// (TD-17); plain HTML, keyboard first.

/** The decision's refusals in words. */
const REFUSALS: Refusals = {
  codes: {
    report_decided: "admin.report.error.report_decided",
    sanction_not_for_report: "admin.report.error.sanction_not_for_report",
    not_found: "admin.report.error.not_found",
  },
  failed: "admin.report.error.failed",
};

/** Whose line it was, in words: never by colour or alignment alone. */
const SIDE: Record<ReportCopyLine["side"], PlainMessageKey> = {
  reporter: "admin.report.side.reporter",
  reported: "admin.report.side.reported",
};

/** An id as the panel shortens it elsewhere (#171). */
const short = (id: string) => id.slice(0, 8);

const decide = (id: string, body: ReportDecisionRequest) =>
  api.POST("/admin/reports/{id}/decision", { params: { path: { id } }, body });

type State =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "missing" }
  | { kind: "forbidden" }
  | { kind: "ready"; report: ReportDetail };

async function read(id: string): Promise<State> {
  try {
    const { data, response } = await api.GET("/admin/reports/{id}", {
      params: { path: { id } },
    });
    // A 403 is the shell's to say (#302).
    if (response.status === 403) return { kind: "forbidden" };
    if (response.status === 404 || response.status === 400) return { kind: "missing" };
    if (!data) return { kind: "error" };
    return { kind: "ready", report: ReportDetail.parse(data) };
  } catch (error) {
    console.error("report page load failed", error);
    return { kind: "error" };
  }
}

export function ReportPage() {
  const { t } = useT();
  const { id = "" } = useParams();
  const [state, setState] = useState<State>({ kind: "loading" });

  // Each open is an audit row: once per id, though StrictMode runs the effect twice.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (opened.current === id) return;
    opened.current = id;
    setState({ kind: "loading" });
    void read(id).then(setState);
  }, [id]);

  return (
    <section aria-labelledby="report-title" className="person">
      <ScreenTitle id="report-title">{t("admin.report.title", { report: short(id) })}</ScreenTitle>
      {state.kind === "loading" && <p aria-busy="true">{t("admin.report.loading")}</p>}
      {state.kind === "error" && <p role="alert">{t("admin.report.error")}</p>}
      {state.kind === "missing" && <p>{t("admin.report.missing")}</p>}
      {state.kind === "ready" && <ReportBody opened={state.report} />}
      <p>
        <Link className="target" to="/reports">
          {t("admin.report.back")}
        </Link>
      </p>
    </section>
  );
}

/** The decision, once there is one: the database sets the three together (report_decision_check). */
function decisionOf({ outcome, decidedAt, decidedBy }: ReportDetail) {
  return outcome && decidedAt && decidedBy ? { outcome, decidedAt, decidedBy } : null;
}

/** What the status line says after an outcome, with the reported person's page when the way on is there. */
type Said = { text: string; person?: string };

type Step = { kind: "close"; item: ReportActable } | { kind: "dismiss" };

/** The report as opened, then as the moderator's decision leaves it, read from no other request. */
function ReportBody({ opened }: { opened: ReportDetail }) {
  const { t, locale } = useT();
  const [report, setReport] = useState(opened);
  const [step, setStep] = useState<Step | null>(null);
  const [said, setSaid] = useState<Said | null>(null);
  // From a sanction's 201 until the decision naming it answers: nothing else
  // may decide the report meanwhile, and the page says it is closing it.
  const [closing, setClosing] = useState(false);
  // Refused as decided by somebody else: the page offers nothing that claims
  // to close it, without reading it again (another conversation.view).
  const [elsewhere, setElsewhere] = useState(false);
  const status = useRef<HTMLParagraphElement>(null);
  const ids = useId();
  const when = (at: string) => formatDateTime(locale, new Date(at));
  const decision = decisionOf(report);
  const reported = report.reported.accountId;

  // An outcome is said in the status line, and the focus goes there: the
  // button that led to it is gone with the decision area.
  useEffect(() => {
    if (said) status.current?.focus();
  }, [said]);

  const settle = (answer: ReportDecision) => {
    setStep(null);
    setReport((r) => ({
      ...r,
      outcome: answer.outcome,
      decidedAt: answer.decidedAt,
      decidedBy: answer.decidedBy,
      sanctionId: answer.sanctionId,
      actable: [],
    }));
  };
  const decidedElsewhere = () => {
    setStep(null);
    setElsewhere(true);
    setSaid({ text: t("admin.report.error.report_decided") });
  };
  const finish = (answer: ReportDecision, text: string) => {
    setStep(null);
    settle(answer);
    setSaid({ text });
  };
  const opening = (next: Step) => {
    setSaid(null);
    setStep(next);
  };

  // The sanction stood with its 201 (#307): this report is named in a second
  // request, and its failure never takes the sanction back.
  const actOn = async (sanction: Sanction, asked: SanctionKind) => {
    const kind = t(KIND_WORDS[asked]);
    setClosing(true);
    setSaid({ text: t("admin.report.closing", { kind }) });
    const outcome = await outcomeOf(
      decide(report.id, { outcome: "acted", sanctionId: sanction.id }),
      ReportDecision,
      REFUSALS,
    );
    setClosing(false);
    if (outcome.kind === "done") {
      settle(outcome.value);
      return setSaid({ text: t("admin.report.done.applied", { kind }) });
    }
    // Decided by somebody else: the sanction is lifted, if at all, on the person's page.
    if (outcome.kind === "refused" && outcome.code === "report_decided") {
      setElsewhere(true);
      return setSaid({ text: t("admin.report.decidedMeanwhile", { kind }), person: reported });
    }
    // Otherwise it closes the report in one more step, from the list: read
    // again, the report would be another conversation.view.
    const { id, kind: applied, reason, createdAt, liftedAt } = sanction;
    setReport((r) => ({
      ...r,
      actable: [{ id, kind: applied, reason, createdAt, liftedAt }, ...r.actable],
    }));
    setSaid({ text: t("admin.report.appliedNotClosed", { kind }) });
  };

  return (
    <>
      <h3>{t("admin.report.factsTitle")}</h3>
      <dl>
        <dt>{t("admin.report.reason")}</dt>
        <dd>{t(REASON[report.reason])}</dd>
        <dt>{t("admin.report.source")}</dt>
        <dd>{t(SOURCE[report.source])}</dd>
        <dt>{t("admin.report.filed")}</dt>
        <dd>{when(report.createdAt)}</dd>
        <dt>{t("admin.report.state")}</dt>
        <dd>
          {decision ? (
            <>
              {t("admin.report.decided", {
                outcome: t(OUTCOME[decision.outcome]),
                time: when(decision.decidedAt),
                who: short(decision.decidedBy),
              })}
              {report.sanctionId && (
                <>
                  {" · "}
                  <Link to={`/accounts/${reported}`}>
                    {t("admin.report.withSanction", { sanction: short(report.sanctionId) })}
                  </Link>
                </>
              )}
            </>
          ) : elsewhere ? (
            t("admin.report.error.report_decided")
          ) : (
            t("admin.report.waiting")
          )}
        </dd>
      </dl>

      <h3>{t("admin.report.peopleTitle")}</h3>
      <ul>
        <li>
          <Link className="target" to={`/accounts/${report.reporter.accountId}`}>
            {t("admin.reports.reporter", { account: short(report.reporter.accountId) })}
          </Link>
          {" · "}
          {t("admin.reports.history.reporter", {
            filed: report.reporter.filed,
            upheld: String(report.reporter.upheld),
          })}
        </li>
        <li>
          <Link className="target" to={`/accounts/${reported}`}>
            {t("admin.reports.reported", { account: short(reported) })}
          </Link>
          {" · "}
          {t("admin.reports.history.reported", {
            received: report.reported.received,
            sanctions: report.reported.sanctions,
          })}
        </li>
      </ul>

      <h3>{t("admin.report.noteTitle")}</h3>
      {report.note === null ? (
        <p>{t("admin.report.noNote")}</p>
      ) : (
        <blockquote className="said">{report.note}</blockquote>
      )}

      {report.copy && (
        <>
          <h3>{t("admin.report.copyTitle")}</h3>
          {report.copy.length === 0 ? (
            <p>{t("admin.report.copyEmpty")}</p>
          ) : (
            <ol className="copy">
              {report.copy.map((line) => (
                <CopyLine key={line.seq} reportId={report.id} line={line} />
              ))}
            </ol>
          )}
        </>
      )}

      <h3>{t("admin.report.decisionTitle")}</h3>
      {decision === null && !elsewhere && !closing && (
        <>
          <p>{t("admin.report.reportedFor", { reason: t(REASON[report.reason]) })}</p>
          <SanctionActions
            accountId={reported}
            legend={t("admin.report.act")}
            also={t("admin.report.actAlso")}
            onOpen={() => setSaid(null)}
            onApplied={actOn}
          />
          {report.actable.length > 0 && (
            <>
              <h4>{t("admin.report.closeWithTitle")}</h4>
              <ul className="sanctions">
                {report.actable.map((s) => {
                  const line = `${ids}-${s.id}`;
                  return (
                    <li key={s.id}>
                      <p id={line}>
                        <strong>{t(KIND_WORDS[s.kind])}</strong> · {t(REASON[s.reason])} ·{" "}
                        {when(s.createdAt)}
                        {s.liftedAt && ` · ${t("admin.report.lifted")}`}
                      </p>
                      <button
                        type="button"
                        aria-describedby={line}
                        onClick={() => opening({ kind: "close", item: s })}
                      >
                        {t("admin.report.closeWith")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <div className="actions">
            <button type="button" className="apart" onClick={() => opening({ kind: "dismiss" })}>
              {t("admin.report.dismiss")}
            </button>
          </div>
        </>
      )}
      <p ref={status} role="status" tabIndex={-1}>
        {said?.text}
        {said?.person && (
          <>
            {" "}
            <Link to={`/accounts/${said.person}`}>{t("admin.report.personPage")}</Link>
          </>
        )}
      </p>
      {step?.kind === "close" && (
        <DecideStep
          title={t("admin.report.closeTitle")}
          effect={t("admin.report.closeEffect", {
            kind: t(KIND_WORDS[step.item.kind]),
            time: when(step.item.createdAt),
          })}
          confirm={t("admin.report.closeConfirm")}
          request={() => decide(report.id, { outcome: "acted", sanctionId: step.item.id })}
          onCancel={() => setStep(null)}
          onDone={async (answer) => finish(answer, t("admin.report.done.acted"))}
          onDecidedElsewhere={decidedElsewhere}
        />
      )}
      {step?.kind === "dismiss" && (
        <DecideStep
          title={t("admin.report.dismissTitle")}
          effect={t("admin.report.dismissEffect")}
          confirm={t("admin.report.dismissConfirm")}
          request={() => decide(report.id, { outcome: "dismissed" })}
          onCancel={() => setStep(null)}
          onDone={async (answer) => finish(answer, t("admin.report.done.dismissed"))}
          onDecidedElsewhere={decidedElsewhere}
        />
      )}
    </>
  );
}

/**
 * The confirm step of a decision, closing with a sanction or dismissing
 * (rules/admin.md): its effect in words, one request at a time, a refusal in
 * words with the step kept open; a 403 closes it, the shell's to say.
 */
function DecideStep({
  title,
  effect,
  confirm,
  request,
  onCancel,
  onDone,
  onDecidedElsewhere,
}: {
  title: string;
  effect: string;
  confirm: string;
  request: () => ReturnType<typeof decide>;
  onCancel: () => void;
  onDone: (answer: ReportDecision) => Promise<void>;
  /** Decided by somebody else meanwhile: the step closes and the page says so. */
  onDecidedElsewhere: () => void;
}) {
  const { t } = useT();
  const { sending, refused, send } = useSend({
    answer: ReportDecision,
    refusals: REFUSALS,
    onShell: onCancel,
    onDone,
    onRefused: (code) => {
      if (code === "report_decided") onDecidedElsewhere();
    },
  });
  return (
    <Dialog title={title} onClose={onCancel}>
      <div className="actions">
        <p>{effect}</p>
        {refused && <p role="alert">{t(refused)}</p>}
        <button type="button" aria-busy={sending || undefined} onClick={() => void send(request)}>
          {confirm}
        </button>
        <button type="button" onClick={onCancel}>
          {t("admin.report.cancel")}
        </button>
      </div>
    </Dialog>
  );
}

/** One line of the frozen copy: whose and when, then its text as text, never as markup or a link. */
function CopyLine({ reportId, line }: { reportId: string; line: ReportCopyLine }) {
  const { t, locale } = useT();
  const head = useId();
  const time = formatDateTime(locale, new Date(line.createdAt));
  return (
    <li>
      <p id={head}>
        <strong>{t(SIDE[line.side])}</strong> · {time}
      </p>
      {line.body !== null && <p className="said">{line.body}</p>}
      {line.kind === "photo" &&
        (line.photo ? (
          <CopyPhoto reportId={reportId} line={line} time={time} describedBy={head} />
        ) : (
          <p>{t("admin.report.photoRemoved")}</p>
        ))}
    </li>
  );
}

/** A photo of the copy, its full variant, fetched only when asked: each look a photo.view row. */
function CopyPhoto({
  reportId,
  line,
  time,
  describedBy,
}: {
  reportId: string;
  line: ReportCopyLine;
  time: string;
  describedBy: string;
}) {
  const { t } = useT();
  const { url, failed, pending, show, picture } = usePhotoOnRequest(() =>
    api.GET("/admin/reports/{id}/copy/{seq}/photo", {
      params: { path: { id: reportId, seq: line.seq } },
    }),
  );
  if (url) {
    return (
      <img
        ref={picture}
        tabIndex={-1}
        className="full"
        src={url}
        alt={t("admin.report.image", { side: line.side, time })}
      />
    );
  }
  return (
    <>
      {failed && <p role="alert">{t("admin.report.photoFailed")}</p>}
      <button
        type="button"
        aria-describedby={describedBy}
        aria-busy={pending || undefined}
        onClick={() => void show()}
      >
        {t("admin.report.showPhoto")}
      </button>
    </>
  );
}
