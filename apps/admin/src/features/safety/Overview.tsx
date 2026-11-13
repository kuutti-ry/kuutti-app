import type { PlainMessageKey } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import { AdminOverview, type FoundReason, type OverviewQueue } from "@kuutti/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Alert } from "../../components/ui/alert.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.tsx";
import { Loading } from "../../components/ui/spinner.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { isLate, useAge } from "../../lib/age.ts";
import { api } from "../../lib/api.ts";
import { RefreshButton } from "../../lib/refresh-button.tsx";
import { ScreenTitle } from "../../lib/screen-title.tsx";
import { Late } from "./late.tsx";

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
  const latest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latest.current;
    setState({ kind: "loading" });
    try {
      const { data, response } = await api.GET("/admin/overview");
      if (request !== latest.current) return;
      // A 403 is the shell's to say (#302).
      if (response.status === 403) return setState({ kind: "forbidden" });
      if (!data) return setState({ kind: "error" });
      setState({ kind: "ready", overview: AdminOverview.parse(data) });
    } catch (error) {
      if (request !== latest.current) return;
      console.error("overview load failed", error);
      setState({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby="overview-title" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScreenTitle id="overview-title">{t("admin.overview.title")}</ScreenTitle>
        <RefreshButton onClick={() => void load()}>{t("admin.overview.refresh")}</RefreshButton>
      </div>
      {state.kind === "loading" && <Loading>{t("load.loading")}</Loading>}
      {state.kind === "error" && <Alert>{t("admin.loadFailed")}</Alert>}
      {state.kind === "ready" && (
        <>
          <ul className="grid gap-4 sm:grid-cols-2">
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
                  <Card className="h-full">
                    <CardContent className="gap-1">
                      <Link className="target text-base font-semibold" to={path}>
                        {t(label)}
                      </Link>{" "}
                      <p className="text-muted-foreground">
                        {q.oldestSince === null
                          ? t("admin.overview.none")
                          : t("admin.overview.waiting", {
                              waiting: q.waiting,
                              age: ageOf(q.oldestSince, now),
                            })}
                      </p>
                      {late && <Late hours={hours} />}
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
          {/* The association's measure (#83, ADR-040): counts by reason, nobody's name. */}
          <Card>
            <CardHeader>
              <CardTitle id="found-them-title">{t("admin.overview.foundThem.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table aria-labelledby="found-them-title">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{t("admin.overview.foundThem.reason")}</TableHead>
                    <TableHead scope="col" className="text-end">
                      {t("admin.overview.foundThem.recent", {
                        days: state.overview.foundThem.days,
                      })}
                    </TableHead>
                    <TableHead scope="col" className="text-end">
                      {t("admin.overview.foundThem.allTime")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {FOUND_REASONS.map(({ reason, label }) => (
                    <TableRow key={reason}>
                      <TableHead scope="row" className="font-normal text-foreground">
                        {t(label)}
                      </TableHead>
                      <TableCell className="text-end tabular-nums">
                        {state.overview.foundThem.recent[reason]}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {state.overview.foundThem.allTime[reason]}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </section>
  );
}
