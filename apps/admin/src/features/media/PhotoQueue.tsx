import { formatDateTime, type PlainMessageKey } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import {
  type PhotoRejectionReason,
  type PhotoReviewItem,
  PhotoReviewQueue,
  PhotoUrlResponse,
} from "@kuutti/schema";
import { useCallback, useEffect, useState } from "react";
import { api, failed } from "../../lib/api.ts";

// The photo review queue (#49, rules/admin.md): what a person decides about
// the photos the automatic check would not approve. Plain HTML, keyboard
// first: every control is a button or a labelled select, the image has its
// alt text, and a decided item announces itself. English only (TD-17).

const REASONS: ReadonlyArray<{ value: PhotoRejectionReason; label: PlainMessageKey }> = [
  { value: "nudity", label: "admin.queue.reason.nudity" },
  { value: "no_person", label: "admin.queue.reason.no_person" },
  { value: "several_people", label: "admin.queue.reason.several_people" },
  { value: "minor", label: "admin.queue.reason.minor" },
  { value: "violence", label: "admin.queue.reason.violence" },
  { value: "contact_details", label: "admin.queue.reason.contact_details" },
  { value: "other", label: "admin.queue.reason.other" },
];

type QueueState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; items: PhotoReviewItem[]; total: number };

export function PhotoQueue() {
  const { t } = useT();
  const [state, setState] = useState<QueueState>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const { data } = await api.GET("/admin/photos/queue", { params: { query: { limit: 20 } } });
      if (!data) return setState({ kind: "error" });
      const queue = PhotoReviewQueue.parse(data);
      setState({ kind: "ready", items: queue.items, total: queue.total });
    } catch (error) {
      // A network failure or an answer that is not the contract: the same
      // error state, never a loading state that nothing will end.
      console.error("queue load failed", error);
      setState({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A decided item stays where it was, saying what was decided, until the
  // next refresh: the moderator sees the result of the click, and the count
  // of what is still waiting goes down.
  const decided = () =>
    setState((previous) =>
      previous.kind === "ready"
        ? { ...previous, total: Math.max(0, previous.total - 1) }
        : previous,
    );

  return (
    <section aria-labelledby="queue-title">
      <header className="row">
        <h2 id="queue-title">{t("admin.queue.title")}</h2>
        <button type="button" onClick={() => void load()}>
          {t("admin.queue.refresh")}
        </button>
      </header>
      {state.kind === "loading" && <p aria-busy="true">{t("admin.queue.loading")}</p>}
      {state.kind === "error" && <p role="alert">{t("admin.queue.error")}</p>}
      {state.kind === "ready" && (
        <>
          <p aria-live="polite">{t("admin.queue.total", { total: state.total })}</p>
          <ul className="queue">
            {state.items.map((item) => (
              <QueueItem key={item.photoId} item={item} onDecided={decided} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

type ItemState =
  | { kind: "idle" }
  | { kind: "rejecting"; reason: PhotoRejectionReason }
  | { kind: "saving" }
  | { kind: "decided"; decision: "approved" | "rejected" }
  | { kind: "failed" };

function QueueItem({ item, onDecided }: { item: PhotoReviewItem; onDecided: () => void }) {
  const { t, locale } = useT();
  const [state, setState] = useState<ItemState>({ kind: "idle" });
  const [url, setUrl] = useState<string | null>(null);

  // The card through a signed URL: one audit row per view, on the API's side.
  useEffect(() => {
    let mounted = true;
    void api
      .GET("/admin/photos/{id}/card", { params: { path: { id: item.photoId } } })
      .then(({ data }) => {
        if (mounted && data) setUrl(PhotoUrlResponse.parse(data).url);
      });
    return () => {
      mounted = false;
    };
  }, [item.photoId]);

  const decide = async (
    body: { decision: "approve" } | { decision: "reject"; reason: PhotoRejectionReason },
  ) => {
    setState({ kind: "saving" });
    const { data, error, response } = await api.POST("/admin/photos/{id}/decision", {
      params: { path: { id: item.photoId } },
      body,
    });
    if (!data) {
      void failed(response, error, "decision");
      setState({ kind: "failed" });
      return;
    }
    setState({ kind: "decided", decision: body.decision === "approve" ? "approved" : "rejected" });
    onDecided();
  };

  const notChecked = item.flagged.includes("not_checked");
  const uploaded = formatDateTime(locale, new Date(item.uploadedAt));

  if (state.kind === "decided") {
    return (
      <li className="item" aria-live="polite">
        {t("admin.queue.decided", { decision: state.decision })}
      </li>
    );
  }

  return (
    <li className="item">
      <figure>
        {url ? (
          <img src={url} alt={t("admin.queue.image")} width={400} height={533} />
        ) : (
          <p aria-busy="true">{t("admin.queue.imageLoading")}</p>
        )}
        <figcaption>
          {t("admin.queue.uploaded", { time: uploaded })} ·{" "}
          {t("admin.queue.account", { account: item.accountId.slice(0, 8) })}
        </figcaption>
      </figure>
      <div className="check">
        <h3>{t("admin.queue.labels")}</h3>
        {notChecked ? (
          <p>{t("admin.queue.notChecked")}</p>
        ) : (
          <>
            <p>{t("admin.queue.faces", { faces: item.faces })}</p>
            {item.labels.length === 0 ? (
              <p>{t("admin.queue.noLabels")}</p>
            ) : (
              <ul>
                {item.labels.map((label) => (
                  <li key={`${label.parentName}/${label.name}`}>
                    {t("admin.queue.label", {
                      name: label.name,
                      confidence: Math.round(label.confidence),
                    })}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <div className="actions">
        {state.kind === "failed" && <p role="alert">{t("admin.queue.decisionFailed")}</p>}
        {state.kind === "rejecting" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void decide({ decision: "reject", reason: state.reason });
            }}
          >
            <label>
              {t("admin.queue.reason.label")}
              <select
                value={state.reason}
                onChange={(event) =>
                  setState({
                    kind: "rejecting",
                    reason: event.target.value as PhotoRejectionReason,
                  })
                }
              >
                {REASONS.map((reason) => (
                  <option key={reason.value} value={reason.value}>
                    {t(reason.label)}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">{t("admin.queue.confirmReject")}</button>
            <button type="button" onClick={() => setState({ kind: "idle" })}>
              {t("admin.queue.cancel")}
            </button>
          </form>
        ) : (
          <>
            <button
              type="button"
              disabled={state.kind === "saving"}
              onClick={() => void decide({ decision: "approve" })}
            >
              {t("admin.queue.approve")}
            </button>
            <button
              type="button"
              disabled={state.kind === "saving"}
              onClick={() => setState({ kind: "rejecting", reason: "nudity" })}
            >
              {t("admin.queue.reject")}
            </button>
          </>
        )}
      </div>
    </li>
  );
}
