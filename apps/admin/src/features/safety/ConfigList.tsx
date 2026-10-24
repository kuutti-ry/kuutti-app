import { formatDateTime } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import {
  ConfigChange,
  type ConfigKey,
  ConfigList as ConfigPage,
  type ConfigValue,
} from "@kuutti/schema";
import { ChevronRight, RefreshCw } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Card, CardContent } from "../../components/ui/card.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { Loading } from "../../components/ui/spinner.tsx";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { api } from "../../lib/api.ts";
import { ScreenTitle } from "../../lib/screen-title.tsx";
import { useList } from "../../lib/use-list.ts";

// The tunables (#304, #305, admins only): every key of matching_config with
// its value and history, and a change with a reason, shown old and new before
// it is sent. The API holds the value to the shape its key declared (the
// first version); the form reads the input the same way, so a typo is caught
// here first. A saved change updates its key in place: nothing else on the
// screen moves. English only (TD-17); keyboard first.

/** A value as the panel shows it: an object as JSON, the rest as it is. */
const shown = (value: ConfigValue) =>
  typeof value === "object" ? JSON.stringify(value) : String(value);

/** The largest whole number a count may hold, as the API holds it (SQL int4). */
const INT4_MAX = 2_147_483_647;

/** A number that keeps what its key declared: a whole number from 0 stays one, a number from 0 stays from 0. */
function fits(declared: number, n: number): boolean {
  if (Number.isInteger(declared) && declared >= 0) {
    return Number.isSafeInteger(n) && n >= 0 && n <= INT4_MAX;
  }
  return declared < 0 || n >= 0;
}

/** The input read as a value of the shape its key declared; null when it is not one. */
function parseAs(declared: ConfigValue, input: string): ConfigValue | null {
  const text = input.trim();
  if (typeof declared === "number") {
    const n = text === "" ? Number.NaN : Number(text);
    return Number.isFinite(n) && fits(declared, n) ? n : null;
  }
  if (typeof declared === "boolean") {
    return text === "true" ? true : text === "false" ? false : null;
  }
  if (typeof declared === "string") return text === "" ? null : text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    const keys = Object.keys(declared);
    const same =
      keys.length === Object.keys(value).length &&
      keys.every((k) => {
        const want = declared[k];
        const got = value[k];
        if (typeof want === "number") return typeof got === "number" && fits(want, got);
        return typeof got === typeof want;
      });
    return same ? (value as ConfigValue) : null;
  } catch {
    return null;
  }
}

/** A key with the version a change wrote put first, as the API now holds it. */
function withChange(item: ConfigKey, change: ConfigChange): ConfigKey {
  const { key: _key, ...version } = change;
  return {
    ...item,
    value: change.value,
    version: change.version,
    versions: [version, ...item.versions].slice(0, 1000),
  };
}

export function ConfigList() {
  const { t } = useT();
  // What the last change wrote, said in a live region that is always there,
  // so the first change is announced too.
  const [saved, setSaved] = useState<ConfigChange | null>(null);
  const { state, reload, update } = useList({
    fetchPage: () => api.GET("/admin/config"),
    parse: (data) => {
      const { items } = ConfigPage.parse(data);
      return { items, total: items.length };
    },
    what: "config",
  });

  return (
    <section aria-labelledby="config-title" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScreenTitle id="config-title">{t("admin.config.title")}</ScreenTitle>
        <Button variant="outline" onClick={() => void reload()}>
          <RefreshCw aria-hidden="true" />
          {t("admin.config.refresh")}
        </Button>
      </div>
      <p aria-live="polite" className="font-medium empty:sr-only">
        {saved
          ? t("admin.config.changed", {
              key: saved.key,
              value: shown(saved.value),
              version: String(saved.version),
            })
          : ""}
      </p>
      {state.kind === "loading" && <Loading>{t("admin.config.loading")}</Loading>}
      {state.kind === "error" && <Alert>{t("admin.config.error")}</Alert>}
      {state.kind === "ready" && (
        <>
          <p className="text-muted-foreground">{t("admin.config.total", { total: state.total })}</p>
          <ul className="grid gap-3">
            {state.items.map((item) => (
              <Tunable
                key={item.key}
                item={item}
                onChanged={(change) => {
                  setSaved(change);
                  update((items) =>
                    items.map((i) => (i.key === change.key ? withChange(i, change) : i)),
                  );
                }}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

type Step =
  | { kind: "editing"; error?: "invalid" | "config_shape" | "config_conflict" | "failed" }
  | { kind: "confirming"; value: ConfigValue }
  | { kind: "saving"; value: ConfigValue };

function Tunable({
  item,
  onChanged,
}: {
  item: ConfigKey;
  onChanged: (change: ConfigChange) => void;
}) {
  const { t, locale } = useT();
  const ids = useId();
  const [input, setInput] = useState(shown(item.value));
  const [reason, setReason] = useState("");
  const [step, setStep] = useState<Step>({ kind: "editing" });
  const object = typeof item.value === "object";
  // The shape the key declared: its first version, the migration's (the history is newest first).
  const declared = item.versions.at(-1)?.value ?? item.value;
  const whole = typeof declared === "number" && Number.isInteger(declared);

  // The focus follows the step: to the confirm sentence when it appears, back
  // to the value when the form returns (a cancel, a refusal, a saved change),
  // so a keyboard or screen-reader user is never left on the page's body.
  const prompt = useRef<HTMLParagraphElement>(null);
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const shownStep = useRef(step.kind);
  useEffect(() => {
    const before = shownStep.current;
    shownStep.current = step.kind;
    if (step.kind === "confirming" && before === "editing") prompt.current?.focus();
    if (step.kind === "editing" && before !== "editing") field.current?.focus();
  }, [step.kind]);

  const review = (event: FormEvent) => {
    event.preventDefault();
    const value = parseAs(declared, input);
    if (value === null) return setStep({ kind: "editing", error: "invalid" });
    setStep({ kind: "confirming", value });
  };

  const send = async (value: ConfigValue) => {
    setStep({ kind: "saving", value });
    const answer = await api
      .POST("/admin/config/{key}", {
        params: { path: { key: item.key } },
        body: { value, reason: reason.trim() },
      })
      .catch(() => null);
    // A 403 is the shell's to say (#302): back to the form without a failure of its own.
    if (answer?.response.status === 403) return setStep({ kind: "editing" });
    if (!answer?.data) {
      const code = (answer?.error as { error?: { code?: string } } | undefined)?.error?.code;
      return setStep({
        kind: "editing",
        error: code === "config_shape" || code === "config_conflict" ? code : "failed",
      });
    }
    // The answer held to its contract, as the list is (rules/admin.md).
    const written = ConfigChange.safeParse(answer.data);
    if (!written.success) return setStep({ kind: "editing", error: "failed" });
    setStep({ kind: "editing" });
    setReason("");
    onChanged(written.data);
  };

  const errorText = {
    invalid: t("admin.config.invalid"),
    config_shape: t("admin.config.shape"),
    config_conflict: t("admin.config.conflict"),
    failed: t("admin.config.failed"),
  } as const;

  return (
    <li>
      <Card className="py-0 sm:py-0">
        <details className="group">
          {/* The browser's marker is hidden; the chevron turns as the disclosure opens. */}
          <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 sm:px-5 [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
            />
            <code className="font-semibold">{item.key}</code>{" "}
            <span className="text-muted-foreground wrap-anywhere">
              {t("admin.config.current", {
                version: String(item.version),
                value: shown(item.value),
              })}
            </span>
          </summary>
          <CardContent className="gap-4 border-t pt-4 pb-4 sm:pb-5">
            <Table className="[&_td]:align-top">
              <TableCaption>{t("admin.config.history")}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t("admin.config.col.version")}</TableHead>
                  <TableHead scope="col">{t("admin.config.col.value")}</TableHead>
                  <TableHead scope="col">{t("admin.config.col.from")}</TableHead>
                  <TableHead scope="col">{t("admin.config.col.by")}</TableHead>
                  <TableHead scope="col">{t("admin.config.col.why")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {item.versions.map((v) => (
                  <TableRow key={v.version}>
                    <TableCell className="tabular-nums">{v.version}</TableCell>
                    <TableCell className="whitespace-normal">
                      <code>{shown(v.value)}</code>
                    </TableCell>
                    <TableCell>{formatDateTime(locale, new Date(v.validFrom))}</TableCell>
                    <TableCell>{v.createdBy}</TableCell>
                    <TableCell className="min-w-48 whitespace-normal">
                      {v.reason ?? t("admin.config.noReason")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {step.kind === "confirming" || step.kind === "saving" ? (
              <div className="grid gap-3 rounded-lg border bg-muted p-3">
                <p ref={prompt} tabIndex={-1} className="font-medium wrap-anywhere">
                  {t("admin.config.confirm", {
                    key: item.key,
                    from: shown(item.value),
                    to: shown(step.value),
                  })}
                </p>
                <div className="flex flex-wrap gap-3">
                  <Button disabled={step.kind === "saving"} onClick={() => void send(step.value)}>
                    {t("admin.config.apply")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={step.kind === "saving"}
                    onClick={() => setStep({ kind: "editing" })}
                  >
                    {t("admin.config.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <form className="grid max-w-2xl gap-4" onSubmit={review}>
                {step.kind === "editing" && step.error && <Alert>{errorText[step.error]}</Alert>}
                <div className="grid gap-2">
                  <Label htmlFor={`${ids}-value`}>{t("admin.config.newValue")}</Label>
                  {object ? (
                    <Textarea
                      id={`${ids}-value`}
                      ref={field}
                      value={input}
                      rows={3}
                      className="font-mono"
                      onChange={(event) => setInput(event.target.value)}
                    />
                  ) : (
                    <Input
                      id={`${ids}-value`}
                      ref={field}
                      inputMode={
                        whole ? "numeric" : typeof item.value === "number" ? "decimal" : "text"
                      }
                      value={input}
                      className="font-mono sm:max-w-xs"
                      onChange={(event) => setInput(event.target.value)}
                    />
                  )}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={`${ids}-reason`}>{t("admin.config.reason")}</Label>
                  <Textarea
                    id={`${ids}-reason`}
                    required
                    maxLength={500}
                    rows={2}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </div>
                <div>
                  <Button type="submit" disabled={reason.trim() === ""}>
                    {t("admin.config.save")}
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </details>
      </Card>
    </li>
  );
}
