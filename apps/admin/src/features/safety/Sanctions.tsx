import { formatDateTime, type PlainMessageKey } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import {
  SANCTION_NOTE_MAX,
  Sanction,
  type SanctionEntry,
  type SanctionKind,
  type SanctionReason,
  SUSPENSION_DAYS_MAX,
} from "@kuutti/schema";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { api } from "../../lib/api.ts";
import { Dialog } from "../../lib/dialog.tsx";
import { useStaffRole } from "../../lib/role.ts";
import { type Refusals, useSend } from "./use-send.ts";

// The sanctions on a person's page (#308), the panel's side of #307: warn,
// hide, suspend until a day, and for admins ban; each through a confirm step
// that says the effect in words, a reason chosen on purpose (nothing preset,
// as the photo queue since #250) and a note. The history lists every
// sanction with who did what, and a lift or a second look where the role
// allows it; the API refuses the rest and the panel says why in words. A 403
// is the shell's to say (#302). The actions and their confirm step are also
// a report's (#312, SanctionActions), where applying one closes the report;
// the second look is also the automatic shadow bans' Confirm and Reverse
// (#105, AutomaticBans). English only (TD-17); keyboard first.

/** The actions in their fixed order: the gentlest first, the ban last and apart. */
const ORDER: readonly SanctionKind[] = ["warn", "shadow_ban", "suspend", "ban"];

const STEPS: Record<
  SanctionKind,
  { action: PlainMessageKey; title: PlainMessageKey; effect: PlainMessageKey }
> = {
  warn: {
    action: "admin.sanction.action.warn",
    title: "admin.sanction.title.warn",
    effect: "admin.sanction.effect.warn",
  },
  shadow_ban: {
    action: "admin.sanction.action.shadow_ban",
    title: "admin.sanction.title.shadow_ban",
    effect: "admin.sanction.effect.shadow_ban",
  },
  suspend: {
    action: "admin.sanction.action.suspend",
    title: "admin.sanction.title.suspend",
    effect: "admin.sanction.effect.suspend",
  },
  ban: {
    action: "admin.sanction.action.ban",
    title: "admin.sanction.title.ban",
    effect: "admin.sanction.effect.ban",
  },
};

/** What a lift does, by kind: a warning and a shadow ban never touched a session (ADR-024 §4). */
const LIFT_EFFECT: Record<SanctionKind, PlainMessageKey> = {
  warn: "admin.sanction.liftEffect.warn",
  shadow_ban: "admin.sanction.liftEffect.shadow_ban",
  suspend: "admin.sanction.liftEffect.suspend",
  ban: "admin.sanction.liftEffect.ban",
};

export const KIND_WORDS: Record<SanctionKind, PlainMessageKey> = {
  warn: "admin.sanction.kind.warn",
  shadow_ban: "admin.sanction.kind.shadow_ban",
  suspend: "admin.sanction.kind.suspend",
  ban: "admin.sanction.kind.ban",
};

const REASONS: ReadonlyArray<{ value: SanctionReason; label: PlainMessageKey }> = [
  { value: "harassment", label: "admin.sanction.reason.harassment" },
  { value: "misrepresentation", label: "admin.sanction.reason.misrepresentation" },
  { value: "under_age", label: "admin.sanction.reason.under_age" },
  { value: "commercial_use", label: "admin.sanction.reason.commercial_use" },
  { value: "scraping", label: "admin.sanction.reason.scraping" },
  { value: "other", label: "admin.sanction.reason.other" },
];
const REASON_WORDS = Object.fromEntries(REASONS.map((r) => [r.value, r.label])) as Record<
  SanctionReason,
  PlainMessageKey
>;

/** The refusals the API answers with a code of their own, in words. */
const REFUSALS: Refusals = {
  codes: {
    staff_target: "admin.sanction.error.staff_target",
    account_deleted: "admin.sanction.error.account_deleted",
    ends_on_invalid: "admin.sanction.error.ends_on_invalid",
    own_account: "admin.sanction.error.own_account",
    own_sanction: "admin.sanction.error.own_sanction",
    sanction_lifted: "admin.sanction.error.sanction_lifted",
    sanction_reviewed: "admin.sanction.error.sanction_reviewed",
    not_found: "admin.sanction.error.not_found",
  },
  failed: "admin.sanction.error.failed",
};

/** A day in the browser's calendar, offset from today, as a date field takes it (YYYY-MM-DD). */
function dayFromToday(offset: number): string {
  const day = new Date();
  day.setDate(day.getDate() + offset);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}`;
}

type Step = { kind: "lift"; item: SanctionEntry } | { kind: "review"; item: SanctionEntry };

/**
 * The actions on a person, the gentlest first, and the confirm step of each
 * (#308): on the person's page under Sanctions, and on a report's (#312),
 * where `also` says in the step what more applying one does there. Only an
 * apply reaches `onApplied`, with the sanction the API answered and the kind
 * the step asked for; a lift and a second look are the person's page's own.
 */
export function SanctionActions({
  accountId,
  legend,
  also,
  onOpen,
  onApplied,
}: {
  accountId: string;
  legend: string;
  also?: string;
  /** A step opens: the line that said the last change is cleared, so the next one is heard. */
  onOpen: () => void;
  onApplied: (sanction: Sanction, asked: SanctionKind) => Promise<void>;
}) {
  const { t } = useT();
  const admin = useStaffRole() === "admin";
  const [step, setStep] = useState<SanctionKind | null>(null);
  return (
    <>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">{legend}</legend>
        <div className="flex flex-wrap gap-3">
          {ORDER.filter((kind) => kind !== "ban" || admin).map((kind) => (
            <Button
              key={kind}
              variant={kind === "ban" ? "destructive" : "outline"}
              className={kind === "ban" ? "sm:ms-auto" : undefined}
              onClick={() => {
                onOpen();
                setStep(kind);
              }}
            >
              {t(STEPS[kind].action)}
            </Button>
          ))}
        </div>
      </fieldset>
      {step && (
        <ApplyStep
          key={step}
          accountId={accountId}
          sanction={step}
          also={also}
          onCancel={() => setStep(null)}
          onShell={() => setStep(null)}
          onDone={async (applied) => {
            setStep(null);
            await onApplied(applied, step);
          }}
        />
      )}
    </>
  );
}

export function Sanctions({
  accountId,
  items,
  onChanged,
}: {
  accountId: string;
  /** Null when the list could not be loaded: the actions stay. */
  items: SanctionEntry[] | null;
  onChanged: () => Promise<void>;
}) {
  const { t, locale } = useT();
  const admin = useStaffRole() === "admin";
  const [step, setStep] = useState<Step | null>(null);
  const [done, setDone] = useState<string>("");
  const status = useRef<HTMLParagraphElement>(null);
  const ids = useId();
  const when = (at: string) => formatDateTime(locale, new Date(at));
  const who = (id: string | null, role: SanctionEntry["createdByRole"]) =>
    id
      ? t("admin.sanction.who", {
          id: id.slice(0, 8),
          role: role ?? t("admin.sanction.noRole"),
        })
      : t("admin.sanction.nobody");

  // A change is said in the status line, and the focus goes there: the button
  // that opened the step may be gone with the change (a lift, a second look).
  useEffect(() => {
    if (done) status.current?.focus();
  }, [done]);

  const finish = async (message: string) => {
    setStep(null);
    setDone(message);
    await onChanged();
  };

  return (
    <>
      <SanctionActions
        accountId={accountId}
        legend={t("admin.sanction.actions")}
        onOpen={() => setDone("")}
        onApplied={(_, asked) =>
          finish(t("admin.sanction.done.apply", { kind: t(KIND_WORDS[asked]) }))
        }
      />
      <p ref={status} role="status" tabIndex={-1} className="font-medium empty:sr-only">
        {done}
      </p>
      {items === null ? (
        <Alert>{t("admin.account.sanctionsError")}</Alert>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground">{t("admin.account.none")}</p>
      ) : (
        <ul className="grid gap-2">
          {items.map((s) => {
            const line = `${ids}-${s.id}`;
            const mayAct = s.kind !== "ban" || admin;
            return (
              <li key={s.id} className="space-y-1 rounded-lg border px-3 py-2">
                <p id={line}>
                  <strong>{t(KIND_WORDS[s.kind])}</strong> · {t(REASON_WORDS[s.reason])} ·{" "}
                  {when(s.createdAt)}
                  {s.endsAt && ` · ${t("admin.account.until", { time: when(s.endsAt) })}`}
                </p>
                <p className="whitespace-pre-wrap wrap-anywhere">{s.note}</p>
                <p className="text-muted-foreground">
                  {t("admin.sanction.appliedBy", { who: who(s.createdBy, s.createdByRole) })}
                </p>
                {s.liftedAt && (
                  <p className="text-muted-foreground">
                    {t("admin.sanction.liftedBy", {
                      time: when(s.liftedAt),
                      who: who(s.liftedBy, s.liftedByRole),
                    })}
                  </p>
                )}
                {s.reviewedAt && (
                  <p className="text-muted-foreground wrap-anywhere">
                    {t("admin.sanction.reviewedBy", {
                      time: when(s.reviewedAt),
                      who: who(s.reviewedBy, s.reviewedByRole),
                      note: s.reviewNote ?? "",
                    })}
                  </p>
                )}
                {mayAct && (!s.liftedAt || !s.reviewedAt) && (
                  <div className="flex flex-wrap gap-3 pt-1">
                    {!s.liftedAt && (
                      <Button
                        variant="outline"
                        aria-describedby={line}
                        onClick={() => {
                          setDone("");
                          setStep({ kind: "lift", item: s });
                        }}
                      >
                        {t("admin.sanction.lift")}
                      </Button>
                    )}
                    {!s.reviewedAt && (
                      <Button
                        variant="outline"
                        aria-describedby={line}
                        onClick={() => {
                          setDone("");
                          setStep({ kind: "review", item: s });
                        }}
                      >
                        {t("admin.sanction.review")}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {step?.kind === "lift" && (
        <LiftStep
          item={step.item}
          onCancel={() => setStep(null)}
          onShell={() => setStep(null)}
          onDone={() =>
            finish(t("admin.sanction.done.lift", { kind: t(KIND_WORDS[step.item.kind]) }))
          }
        />
      )}
      {step?.kind === "review" && (
        <ReviewStep
          item={step.item}
          onCancel={() => setStep(null)}
          onShell={() => setStep(null)}
          onDone={() =>
            finish(t("admin.sanction.done.review", { kind: t(KIND_WORDS[step.item.kind]) }))
          }
        />
      )}
    </>
  );
}

type StepProps = {
  onCancel: () => void;
  onShell: () => void;
  onDone: (sanction: Sanction) => Promise<void>;
};

function ApplyStep({
  accountId,
  sanction,
  also,
  onCancel,
  onShell,
  onDone,
}: StepProps & { accountId: string; sanction: SanctionKind; also: string | undefined }) {
  const { t } = useT();
  const ids = useId();
  const [reason, setReason] = useState<SanctionReason | "">("");
  const [note, setNote] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const { sending, refused, send } = useSend({
    answer: Sanction,
    refusals: REFUSALS,
    onShell,
    onDone,
  });
  const meta = STEPS[sanction];
  const ready = reason !== "" && note.trim() !== "" && (sanction !== "suspend" || endsOn !== "");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const path = { params: { path: { id: accountId } } };
    const text = note.trim();
    void send(() => {
      if (sanction === "ban") {
        return api.POST("/admin/accounts/{id}/bans", { ...path, body: { reason, note: text } });
      }
      const body =
        sanction === "suspend"
          ? { kind: sanction, reason, note: text, endsOn }
          : { kind: sanction, reason, note: text };
      return api.POST("/admin/accounts/{id}/sanctions", { ...path, body });
    });
  };

  return (
    <Dialog title={t(meta.title)} onClose={onCancel}>
      <form className="grid gap-4" onSubmit={submit}>
        <p>{t(meta.effect)}</p>
        {also && <p className="text-muted-foreground">{also}</p>}
        {refused && <Alert>{t(refused)}</Alert>}
        <div className="grid gap-2">
          <Label htmlFor={`${ids}-reason`}>{t("admin.sanction.reason.label")}</Label>
          <NativeSelect
            id={`${ids}-reason`}
            required
            value={reason}
            onChange={(event) => setReason(event.target.value as SanctionReason)}
          >
            <option value="" disabled>
              {t("admin.sanction.reason.choose")}
            </option>
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {t(r.label)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${ids}-note`}>{t("admin.sanction.note")}</Label>
          <Textarea
            id={`${ids}-note`}
            required
            rows={3}
            maxLength={SANCTION_NOTE_MAX}
            aria-describedby={`${ids}-count`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <p id={`${ids}-count`} className="text-xs text-muted-foreground">
            {t("admin.sanction.noteCount", {
              characters: String(note.length),
              max: String(SANCTION_NOTE_MAX),
            })}
          </p>
        </div>
        {sanction === "suspend" && (
          <div className="grid gap-2">
            <Label htmlFor={`${ids}-ends`}>{t("admin.sanction.endsOn")}</Label>
            <Input
              id={`${ids}-ends`}
              type="date"
              required
              min={dayFromToday(1)}
              max={dayFromToday(SUSPENSION_DAYS_MAX)}
              value={endsOn}
              onChange={(event) => setEndsOn(event.target.value)}
              className="sm:w-fit"
            />
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            variant={sanction === "ban" ? "destructive" : "default"}
            disabled={!ready}
            aria-busy={sending || undefined}
          >
            {t("admin.sanction.apply")}
          </Button>
          <Button variant="outline" onClick={onCancel}>
            {t("admin.sanction.cancel")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const liftPath = (item: Pick<Sanction, "id">) => ({ params: { path: { id: item.id } } });

/** A radio and its words as one bordered target of 44 px, the dot saying which is chosen. */
const CHOICE =
  "flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-input px-3 has-checked:bg-accent has-checked:font-semibold has-checked:text-accent-foreground";

function LiftStep({ item, onCancel, onShell, onDone }: StepProps & { item: SanctionEntry }) {
  const { t } = useT();
  const { sending, refused, send } = useSend({
    answer: Sanction,
    refusals: REFUSALS,
    onShell,
    onDone,
  });
  return (
    <Dialog
      title={t("admin.sanction.liftTitle", { kind: t(KIND_WORDS[item.kind]) })}
      onClose={onCancel}
    >
      <div className="grid gap-4">
        <p>{t(LIFT_EFFECT[item.kind])}</p>
        {refused && <Alert>{t(refused)}</Alert>}
        <div className="flex flex-wrap gap-3">
          <Button
            aria-busy={sending || undefined}
            onClick={() =>
              void send(() =>
                item.kind === "ban"
                  ? api.POST("/admin/bans/{id}/lift", liftPath(item))
                  : api.POST("/admin/sanctions/{id}/lift", liftPath(item)),
              )
            }
          >
            {t("admin.sanction.lift")}
          </Button>
          <Button variant="outline" onClick={onCancel}>
            {t("admin.sanction.cancel")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * A second look whose decision is the button that opened it (#105: Confirm or
 * Reverse on the automatic shadow bans): no choice in the step, so nothing is
 * preset in it (rules/admin.md), and its title, effect and button say that
 * decision.
 */
export type FixedReview = {
  outcome: "keep" | "lift";
  title: string;
  effect: string;
  submit: string;
};

/** A second look at a sanction (#307): a note, and keep it or lift it; on a person's page and the automatic bans' list. */
export function ReviewStep({
  item,
  fixed,
  onCancel,
  onShell,
  onDone,
}: StepProps & { item: Pick<Sanction, "id" | "kind" | "liftedAt">; fixed?: FixedReview }) {
  const { t } = useT();
  const ids = useId();
  const [note, setNote] = useState("");
  const [chosen, setOutcome] = useState<"keep" | "lift" | "">("");
  const outcome = fixed?.outcome ?? chosen;
  const { sending, refused, send } = useSend({
    answer: Sanction,
    refusals: REFUSALS,
    onShell,
    onDone,
  });
  const ready = note.trim() !== "" && outcome !== "";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const request = { ...liftPath(item), body: { note: note.trim(), outcome } };
    void send(() =>
      item.kind === "ban"
        ? api.POST("/admin/bans/{id}/review", request)
        : api.POST("/admin/sanctions/{id}/review", request),
    );
  };
  return (
    <Dialog
      title={fixed?.title ?? t("admin.sanction.reviewTitle", { kind: t(KIND_WORDS[item.kind]) })}
      onClose={onCancel}
    >
      <form className="grid gap-4" onSubmit={submit}>
        <p>{fixed?.effect ?? t("admin.sanction.reviewExplain")}</p>
        {refused && <Alert>{t(refused)}</Alert>}
        <div className="grid gap-2">
          <Label htmlFor={`${ids}-note`}>{t("admin.sanction.reviewNote")}</Label>
          <Textarea
            id={`${ids}-note`}
            required
            rows={3}
            maxLength={SANCTION_NOTE_MAX}
            aria-describedby={`${ids}-count`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <p id={`${ids}-count`} className="text-xs text-muted-foreground">
            {t("admin.sanction.noteCount", {
              characters: String(note.length),
              max: String(SANCTION_NOTE_MAX),
            })}
          </p>
        </div>
        {!fixed && (
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">{t("admin.sanction.outcome")}</legend>
            <label className={CHOICE}>
              <input
                className="size-4 accent-primary"
                type="radio"
                name={`${ids}-outcome`}
                value="keep"
                checked={outcome === "keep"}
                onChange={() => setOutcome("keep")}
              />
              {t("admin.sanction.keep")}
            </label>
            {!item.liftedAt && (
              <label className={CHOICE}>
                <input
                  className="size-4 accent-primary"
                  type="radio"
                  name={`${ids}-outcome`}
                  value="lift"
                  checked={outcome === "lift"}
                  onChange={() => setOutcome("lift")}
                />
                {t("admin.sanction.liftIt")}
              </label>
            )}
          </fieldset>
        )}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={!ready} aria-busy={sending || undefined}>
            {fixed?.submit ?? t("admin.sanction.apply")}
          </Button>
          <Button variant="outline" onClick={onCancel}>
            {t("admin.sanction.cancel")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
