import type { PlainMessageKey } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import { AdminOverview, type OverviewQueue } from "@kuutti/schema";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../../lib/api.ts";
import { ScreenTitle } from "../../lib/screen-title.tsx";

// The panel's front page (#303): what waits in each queue and how long the
// oldest has, measured by the API's clock, with the response time the
// association promises (#299): past it the line says "Late" in words and
// weight, never by colour alone. Counts of queues only; nothing about a
// person. English only (TD-17).

const QUEUES: Record<OverviewQueue["queue"], { label: PlainMessageKey; path: string }> = {
  photos: { label: "admin.overview.queue.photos", path: "/photos" },
  feedback: { label: "admin.overview.queue.feedback", path: "/feedback" },
};

const HOUR_MS = 3_600_000;

type State =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "forbidden" }
  | { kind: "ready"; overview: AdminOverview };

export function Overview() {
  const { t } = useT();
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const { data, response } = await api.GET("/admin/overview");
      // A 403 is the shell's to say (#302).
      if (response.status === 403) return setState({ kind: "forbidden" });
      if (!data) return setState({ kind: "error" });
      setState({ kind: "ready", overview: AdminOverview.parse(data) });
    } catch (error) {
      console.error("overview load failed", error);
      setState({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** How long the oldest has waited, in the coarsest unit that still says it. */
  const ageOf = (since: string, now: string) => {
    const hours = Math.floor((Date.parse(now) - Date.parse(since)) / HOUR_MS);
    if (hours < 1) return t("admin.overview.age.lessThanHour");
    if (hours < 48) return t("admin.overview.age.hours", { hours });
    return t("admin.overview.age.days", { days: Math.floor(hours / 24) });
  };

  return (
    <section aria-labelledby="overview-title">
      <div className="row">
        <ScreenTitle id="overview-title">{t("admin.overview.title")}</ScreenTitle>
        <button type="button" onClick={() => void load()}>
          {t("admin.overview.refresh")}
        </button>
      </div>
      {state.kind === "loading" && <p aria-busy="true">{t("admin.overview.loading")}</p>}
      {state.kind === "error" && <p role="alert">{t("admin.overview.error")}</p>}
      {state.kind === "ready" && (
        <>
          {state.overview.queues.every((q) => q.waiting === 0) && (
            <p>{t("admin.overview.empty")}</p>
          )}
          <ul className="overview">
            {state.overview.queues.map((q) => {
              const { label, path } = QUEUES[q.queue];
              const { now, responseHours } = state.overview;
              const late =
                q.oldestSince !== null &&
                Date.parse(now) - Date.parse(q.oldestSince) > responseHours * HOUR_MS;
              return (
                <li key={q.queue}>
                  <Link className="target" to={path}>
                    {t(label)}
                  </Link>{" "}
                  {q.oldestSince === null
                    ? t("admin.overview.none")
                    : t("admin.overview.waiting", {
                        waiting: q.waiting,
                        age: ageOf(q.oldestSince, now),
                      })}
                  {late && (
                    <>
                      {" "}
                      <strong>{t("admin.overview.late", { hours: String(responseHours) })}</strong>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
