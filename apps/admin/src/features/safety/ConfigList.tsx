import { formatDateTime } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import {
  ConfigChange,
  type ConfigKey,
  ConfigList as ConfigPage,
  type ConfigValue,
} from "@kuutti/schema";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { ScreenTitle } from "../../lib/screen-title.tsx";
import { useList } from "../../lib/use-list.ts";

// The tunables (#304, #305, admins only): every key of matching_config with
// its value and history, and a change with a reason, shown old and new before
// it is sent. The API holds the value to the shape its key declared (the
// first version); the form reads the input the same way, so a typo is caught
// here first. A saved change updates its key in place: nothing else on the
// screen moves. English only (TD-17); plain HTML, keyboard first.

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
    <section aria-labelledby="config-title">
      <div className="row">
        <ScreenTitle id="config-title">{t("admin.config.title")}</ScreenTitle>
        <button type="button" onClick={() => void reload()}>
          {t("admin.config.refresh")}
        </button>
      </div>
      <p aria-live="polite">
        {saved
          ? t("admin.config.changed", {
              key: saved.key,
              value: shown(saved.value),
              version: String(saved.version),
            })
          : ""}
      </p>
      {state.kind === "loading" && <p aria-busy="true">{t("admin.config.loading")}</p>}
      {state.kind === "error" && <p role="alert">{t("admin.config.error")}</p>}
      {state.kind === "ready" && (
        <>
          <p>{t("admin.config.total", { total: state.total })}</p>
          <ul className="queue">
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
    <li className="item tunable">
      <details>
        <summary>
          <code>{item.key}</code>{" "}
          {t("admin.config.current", { version: String(item.version), value: shown(item.value) })}
        </summary>
        <table>
          <caption>{t("admin.config.history")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("admin.config.col.version")}</th>
              <th scope="col">{t("admin.config.col.value")}</th>
              <th scope="col">{t("admin.config.col.from")}</th>
              <th scope="col">{t("admin.config.col.by")}</th>
              <th scope="col">{t("admin.config.col.why")}</th>
            </tr>
          </thead>
          <tbody>
            {item.versions.map((v) => (
              <tr key={v.version}>
                <td>{v.version}</td>
                <td>
                  <code>{shown(v.value)}</code>
                </td>
                <td>{formatDateTime(locale, new Date(v.validFrom))}</td>
                <td>{v.createdBy}</td>
                <td>{v.reason ?? t("admin.config.noReason")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {step.kind === "confirming" || step.kind === "saving" ? (
          <div className="actions">
            <p ref={prompt} tabIndex={-1}>
              {t("admin.config.confirm", {
                key: item.key,
                from: shown(item.value),
                to: shown(step.value),
              })}
            </p>
            <button
              type="button"
              disabled={step.kind === "saving"}
              onClick={() => void send(step.value)}
            >
              {t("admin.config.apply")}
            </button>
            <button
              type="button"
              disabled={step.kind === "saving"}
              onClick={() => setStep({ kind: "editing" })}
            >
              {t("admin.config.cancel")}
            </button>
          </div>
        ) : (
          <form className="actions" onSubmit={review}>
            {step.kind === "editing" && step.error && <p role="alert">{errorText[step.error]}</p>}
            <label htmlFor={`${ids}-value`}>{t("admin.config.newValue")}</label>
            {object ? (
              <textarea
                id={`${ids}-value`}
                ref={field}
                value={input}
                rows={3}
                onChange={(event) => setInput(event.target.value)}
              />
            ) : (
              <input
                id={`${ids}-value`}
                ref={field}
                inputMode={whole ? "numeric" : typeof item.value === "number" ? "decimal" : "text"}
                value={input}
                onChange={(event) => setInput(event.target.value)}
              />
            )}
            <label htmlFor={`${ids}-reason`}>{t("admin.config.reason")}</label>
            <textarea
              id={`${ids}-reason`}
              required
              maxLength={500}
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <button type="submit" disabled={reason.trim() === ""}>
              {t("admin.config.save")}
            </button>
          </form>
        )}
      </details>
    </li>
  );
}
