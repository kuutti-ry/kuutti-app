import type { PlainMessageKey } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import { AdminOverview, type FoundReason, type OverviewQueue } from "@kuutti/schema";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { isLate, useAge } from "../../lib/age.ts";
import { api } from "../../lib/api.ts";
import { ScreenTitle } from "../../lib/screen-title.tsx";

// The panel's front page (#303): what waits in each queue and how long the
// oldest has, measured by the API's clock, with the response time the
// association promises (#299), or for the automatic shadow bans the review
// time of their own (#105): past it the line says "Late" in words and weight,
// never by colour alone. Counts of queues only; nothing about a person.
// English only (TD-17).

const QUEUES: Record<OverviewQueue["queue"], { label: PlainMessageKey; path: string }> = {
  reports: { label: "admin.overview.queue.reports", path: "/reports" },
  automatic_bans: { label: "admin.overview.queue.automaticBans", path: "/automatic-bans" },
  photos: { label: "admin.overview.queue.photos", path: "/photos" },
  feedback: { label: "admin.overview.queue.feedback", path: "/feedback" },
};

/** "Löysin hänet"'s reasons, the first the association's measure of success (#83). */
const FOUND_REASONS: ReadonlyArray<{ reason: FoundReason; label: PlainMessageKey }> = [
  { reason: "here", label: "admin.overview.foundThem.here" },
  { reason: "elsewhere", label: "admin.overview.foundThem.elsewhere" },
  { reason: "other", label: "admin.overview.foundThem.other" },
];

type State =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "forbidden" }
  | { kind: "ready"; overview: AdminOverview };

export function Overview() {
  const { t } = useT();
  const [state, setState] = useState<State>({ kind: "loading" });
  const ageOf = useAge();

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
              const { now } = state.overview;
              const hours =
                q.queue === "automatic_bans"
                  ? state.overview.reviewHours
                  : state.overview.responseHours;
              const late = q.oldestSince !== null && isLate(q.oldestSince, now, hours);
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
                      <strong>{t("admin.late", { hours: String(hours) })}</strong>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {/* The association's measure (#83, ADR-040): counts by reason, nobody's name. */}
          <h3 id="found-them-title">{t("admin.overview.foundThem.title")}</h3>
          <p>{t("admin.overview.foundThem.note")}</p>
          <table aria-labelledby="found-them-title">
            <thead>
              <tr>
                <th scope="col">{t("admin.overview.foundThem.reason")}</th>
                <th scope="col">
                  {t("admin.overview.foundThem.recent", { days: state.overview.foundThem.days })}
                </th>
                <th scope="col">{t("admin.overview.foundThem.allTime")}</th>
              </tr>
            </thead>
            <tbody>
              {FOUND_REASONS.map(({ reason, label }) => (
                <tr key={reason}>
                  <th scope="row">{t(label)}</th>
                  <td>{state.overview.foundThem.recent[reason]}</td>
                  <td>{state.overview.foundThem.allTime[reason]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
