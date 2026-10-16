import { formatDateTime } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import {
  type ConfigChange,
  type ConfigKey,
  ConfigList as ConfigPage,
  type ConfigValue,
} from "@kuutti/schema";
import { type FormEvent, useId, useState } from "react";
import { api } from "../../lib/api.ts";
import { ScreenTitle } from "../../lib/screen-title.tsx";
import { useList } from "../../lib/use-list.ts";

// The tunables (#304, #305, admins only): every key of matching_config with
// its value and history, and a change with a reason, shown old and new before
// it is sent. The API holds the value to the current one's shape; the form
// reads the input by the current value's type so a typo is caught here first.
// English only (TD-17); plain HTML, keyboard first.

/** A value as the panel shows it: an object as JSON, the rest as it is. */
const shown = (value: ConfigValue) =>
  typeof value === "object" ? JSON.stringify(value) : String(value);

/** The input read as a value of the current one's type; null when it is not one. */
function parseAs(current: ConfigValue, input: string): ConfigValue | null {
  const text = input.trim();
  if (typeof current === "number") {
    const n = text === "" ? Number.NaN : Number(text);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof current === "boolean") return text === "true" ? true : text === "false" ? false : null;
  if (typeof current === "string") return text === "" ? null : text;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ConfigValue)
      : null;
  } catch {
    return null;
  }
}

export function ConfigList() {
  const { t } = useT();
  // What the last change wrote, said above the list: the list reloads behind
  // it, and a row's own state would go with the reload.
  const [saved, setSaved] = useState<ConfigChange | null>(null);
  const { state, reload } = useList({
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
      {saved && (
        <p aria-live="polite">
          {t("admin.config.changed", {
            key: saved.key,
            value: shown(saved.value),
            version: String(saved.version),
          })}
        </p>
      )}
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
                  void reload();
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

  const review = (event: FormEvent) => {
    event.preventDefault();
    const value = parseAs(item.value, input);
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
    setStep({ kind: "editing" });
    setReason("");
    onChanged(answer.data);
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
            <p>
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
                value={input}
                rows={3}
                onChange={(event) => setInput(event.target.value)}
              />
            ) : (
              <input
                id={`${ids}-value`}
                inputMode={typeof item.value === "number" ? "decimal" : "text"}
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
