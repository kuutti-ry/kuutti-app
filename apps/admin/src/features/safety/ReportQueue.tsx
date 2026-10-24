import { formatDateTime } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import {
  type ReportListItem,
  ReportQueue as ReportPage,
  type ReportQueueQuery,
} from "@kuutti/schema";
import { Clock, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Alert } from "../../components/ui/alert.tsx";
import { badgeVariants } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { Loading } from "../../components/ui/spinner.tsx";
import { isLate, useAge } from "../../lib/age.ts";
import { api } from "../../lib/api.ts";
import { ScreenTitle } from "../../lib/screen-title.tsx";
import { useList } from "../../lib/use-list.ts";
import { OUTCOME, REASON, SOURCE } from "./report-words.ts";

// The report queue (#311, TD-5, rules/admin.md): the reports waiting for a
// decision, the oldest first, those about one person under one heading, each
// with its age against the response time promised (#299), "Late" in words
// and weight; and both people by account id, linked to their pages (#306),
// with how each has figured in reports before. Decided reports are behind the
// filter, for the record. Neither the reporter's words nor the conversation
// are here: each report's first line opens its own page (#312, ReportPage),
// whose every open is an audit row. The values' words are shared with that
// page (report-words.ts). Keyboard first; English only (TD-17).

type State = ReportQueueQuery["state"];

/** The account id as the panel shortens it elsewhere (#171). */
const short = (accountId: string) => accountId.slice(0, 8);

/** Reports about one person under one heading, named by the first one's id. */
type Group = { id: string; reported: ReportListItem["reported"]; items: ReportListItem[] };

/** Neighbours about the same person under one heading; the API puts a person's open reports together. */
function groupsOf(items: ReportListItem[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last?.reported.accountId === item.reported.accountId) last.items.push(item);
    else groups.push({ id: item.id, reported: item.reported, items: [item] });
  }
  return groups;
}

export function ReportQueue() {
  const { t } = useT();
  // The filter is the screen's own state, not a move: the focus stays on it.
  const [state, setState] = useState<State>("open");
  return (
    <section aria-labelledby="reports-title" className="space-y-6">
      <ScreenTitle id="reports-title">{t("admin.reports.title")}</ScreenTitle>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">{t("admin.reports.show")}</legend>
        {/* A segmented choice whose dot says which, not its colour. */}
        <div className="inline-flex flex-wrap gap-1 rounded-lg border bg-card p-1">
          {(["open", "closed"] as const).map((value) => (
            <label
              key={value}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-3 text-sm font-medium has-checked:bg-accent has-checked:font-semibold has-checked:text-accent-foreground"
            >
              <input
                type="radio"
                name="report-state"
                value={value}
                checked={state === value}
                onChange={() => setState(value)}
                className="size-4 accent-primary"
              />
              {t(value === "open" ? "admin.reports.show.open" : "admin.reports.show.closed")}
            </label>
          ))}
        </div>
      </fieldset>
      {/* A new filter is a new list: loaded afresh, never the other state's rows. */}
      <ReportList key={state} state={state} />
    </section>
  );
}

function ReportList({ state }: { state: State }) {
  const { t } = useT();
  const { state: page, reload } = useList({
    fetchPage: () => api.GET("/admin/reports", { params: { query: { state, limit: 50 } } }),
    parse: (data) => ReportPage.parse(data),
    what: "reports",
  });
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {page.kind === "ready" && (
          <p aria-live="polite" className="text-muted-foreground">
            {t(state === "open" ? "admin.reports.total.open" : "admin.reports.total.closed", {
              total: page.total,
            })}
            {page.items.length < page.total && (
              <> {t("admin.reports.shown", { shown: String(page.items.length) })}</>
            )}
          </p>
        )}
        <Button variant="outline" className="ms-auto" onClick={() => void reload()}>
          <RefreshCw aria-hidden="true" />
          {t("admin.reports.refresh")}
        </Button>
      </div>
      {page.kind === "loading" && <Loading>{t("admin.reports.loading")}</Loading>}
      {page.kind === "error" && <Alert>{t("admin.reports.error")}</Alert>}
      {page.kind === "ready" && (
        <ul className="grid gap-4">
          {groupsOf(page.items).map((group) => (
            <ReportGroup
              key={group.id}
              group={group}
              now={page.now}
              responseHours={page.responseHours}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function ReportGroup({
  group: { reported, items },
  now,
  responseHours,
}: {
  group: Group;
  now: string;
  responseHours: number;
}) {
  const { t, locale } = useT();
  const ageOf = useAge();
  return (
    <li>
      <Card>
        <CardHeader className="flex-col gap-0">
          <CardTitle>
            <Link className="target" to={`/accounts/${reported.accountId}`}>
              {t("admin.reports.reported", { account: short(reported.accountId) })}
            </Link>
          </CardTitle>
          <CardDescription>
            {t("admin.reports.history.reported", {
              received: reported.received,
              sanctions: reported.sanctions,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2">
            {items.map((item) => (
              <li key={item.id} className="space-y-1 rounded-lg border px-3 py-2">
                <p>
                  {/* One link per report, named by its reason, source and filing time. */}
                  <Link className="target" to={`/reports/${item.id}`}>
                    <strong>{t(REASON[item.reason])}</strong>, {t(SOURCE[item.source])} ·{" "}
                    {t("admin.reports.filed", {
                      time: formatDateTime(locale, new Date(item.createdAt)),
                    })}
                  </Link>
                </p>
                {item.decidedAt === null ? (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                    {t("admin.reports.waiting", { age: ageOf(item.createdAt, now) })}
                    {isLate(item.createdAt, now, responseHours) && (
                      <>
                        {" "}
                        <strong className={badgeVariants({ variant: "destructive" })}>
                          <Clock aria-hidden="true" />
                          {t("admin.late", { hours: String(responseHours) })}
                        </strong>
                      </>
                    )}
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    {item.outcome && (
                      <strong className="text-foreground">{t(OUTCOME[item.outcome])}</strong>
                    )}{" "}
                    ·{" "}
                    {t("admin.reports.decided", {
                      time: formatDateTime(locale, new Date(item.decidedAt)),
                    })}
                  </p>
                )}
                <p className="text-muted-foreground">
                  <Link to={`/accounts/${item.reporter.accountId}`}>
                    {t("admin.reports.reporter", { account: short(item.reporter.accountId) })}
                  </Link>
                  {" · "}
                  {t("admin.reports.history.reporter", {
                    filed: item.reporter.filed,
                    upheld: String(item.reporter.upheld),
                  })}
                </p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </li>
  );
}
