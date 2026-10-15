import { formatDateTime, type PlainMessageKey } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import { type FeedbackItem, type FeedbackKind, FeedbackList as FeedbackPage } from "@kuutti/schema";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";

// Feedback from inside the app (#171, ADR-023, rules/admin.md): what people
// sent, a bug first and praise last, each with the build the app read and the
// sender's account id; a moderator marks a row handled, which is an
// audit_log row. Plain HTML, keyboard first; English only (TD-17).

const KIND_LABEL: Record<FeedbackKind, PlainMessageKey> = {
  bug: "admin.feedback.kind.bug",
  idea: "admin.feedback.kind.idea",
  complaint: "admin.feedback.kind.complaint",
  praise: "admin.feedback.kind.praise",
};

type ListState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; items: FeedbackItem[]; total: number };

export function FeedbackList() {
  const { t } = useT();
  const [state, setState] = useState<ListState>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const { data } = await api.GET("/admin/feedback", { params: { query: { limit: 50 } } });
      if (!data) return setState({ kind: "error" });
      const page = FeedbackPage.parse(data);
      setState({ kind: "ready", items: page.items, total: page.total });
    } catch (error) {
      // A network failure or an answer that is not the contract: the same
      // error state, never a loading state that nothing will end.
      console.error("feedback load failed", error);
      setState({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A handled row stays where it was, saying so, until the next refresh; the
  // count of what still waits goes down.
  const handled = () =>
    setState((previous) =>
      previous.kind === "ready"
        ? { ...previous, total: Math.max(0, previous.total - 1) }
        : previous,
    );

  return (
    <section aria-labelledby="feedback-title">
      <div className="row">
        <h2 id="feedback-title">{t("admin.feedback.title")}</h2>
        <button type="button" onClick={() => void load()}>
          {t("admin.feedback.refresh")}
        </button>
      </div>
      {state.kind === "loading" && <p aria-busy="true">{t("admin.feedback.loading")}</p>}
      {state.kind === "error" && <p role="alert">{t("admin.feedback.error")}</p>}
      {state.kind === "ready" && (
        <>
          <p aria-live="polite">{t("admin.feedback.total", { total: state.total })}</p>
          <ul className="queue">
            {state.items.map((item) => (
              <FeedbackRow key={item.id} item={item} onHandled={handled} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function FeedbackRow({ item, onHandled }: { item: FeedbackItem; onHandled: () => void }) {
  const { t, locale } = useT();
  const [state, setState] = useState<"idle" | "saving" | "handled" | "failed">("idle");

  const mark = async () => {
    setState("saving");
    const { data } = await api
      .POST("/admin/feedback/{id}/handled", { params: { path: { id: item.id } } })
      .catch(() => ({ data: undefined }));
    if (!data) {
      setState("failed");
      return;
    }
    setState("handled");
    onHandled();
  };

  if (state === "handled") {
    return (
      <li className="item" aria-live="polite">
        {t("admin.feedback.handled")}
      </li>
    );
  }
  return (
    <li className="item">
      <h3>{t(KIND_LABEL[item.kind])}</h3>
      <p>{item.text}</p>
      <p>
        {t("admin.feedback.meta", {
          version: item.appVersion,
          platform: item.platform,
          locale: item.locale,
          time: formatDateTime(locale, new Date(item.createdAt)),
          account: item.accountId.slice(0, 8),
        })}
      </p>
      <div className="actions">
        {state === "failed" && <p role="alert">{t("admin.feedback.handleFailed")}</p>}
        <button type="button" disabled={state === "saving"} onClick={() => void mark()}>
          {t("admin.feedback.handle")}
        </button>
      </div>
    </li>
  );
}
