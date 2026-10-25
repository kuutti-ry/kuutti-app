import { formatDateTime } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import { AuditPage, type AuditQuery } from "@kuutti/schema";
import { ChevronLeft, ChevronRight, Filter } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
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
import { api } from "../../lib/api.ts";
import { ScreenTitle } from "../../lib/screen-title.tsx";
import { AuditDetail } from "./audit-detail.tsx";

// The audit log's reader (#309, admins only): who did or saw what, narrowed
// by who, what, whom and when, a page at a time and never all at once
// (rules/admin.md). "Newer" walks back the cursors this screen was given; the
// API only pages older. Only the answer to the latest request is shown, so a
// slow page never lands over the filters applied after it. English only
// (TD-17).

type Filters = {
  actor: string;
  action: string;
  subjectType: string;
  subjectId: string;
  from: string;
  to: string;
};
const EMPTY: Filters = { actor: "", action: "", subjectType: "", subjectId: "", from: "", to: "" };

/** The form's filters as the API's query: empty fields left out, days as the start of the day in the browser's zone. */
function queryOf(filters: Filters, before: string | null): AuditQuery {
  const day = (value: string) => (value ? new Date(`${value}T00:00:00`).toISOString() : undefined);
  const out: AuditQuery = {};
  if (filters.actor.trim()) out.actor = filters.actor.trim();
  if (filters.action.trim()) out.action = filters.action.trim();
  if (filters.subjectType.trim()) out.subjectType = filters.subjectType.trim();
  if (filters.subjectId.trim()) out.subjectId = filters.subjectId.trim();
  const from = day(filters.from);
  if (from) out.from = from;
  // The "to" day is included: the window ends at the start of the next day.
  if (filters.to) {
    const end = new Date(`${filters.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    out.to = end.toISOString();
  }
  if (before) out.before = before;
  return out;
}

type State =
  | { kind: "loading" }
  | { kind: "error"; invalid: boolean }
  | { kind: "forbidden" }
  | { kind: "ready"; page: AuditPage };

export function AuditLog() {
  const { t, locale } = useT();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  // The cursors of the pages shown so far, the newest first: the last is this page's.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [state, setState] = useState<State>({ kind: "loading" });
  const before = cursors.at(-1) ?? null;
  // Every "Show" asks again, the same filters too: after a failure, or for the newest rows.
  const [asked, setAsked] = useState(0);
  const latest = useRef(0);
  // A page reached by Newer or Older takes the focus, as the button that asked is gone while it loads.
  const paged = useRef(false);
  const shownPage = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const ticket = ++latest.current;
    const settle = (next: State) => {
      if (ticket === latest.current) setState(next);
    };
    setState({ kind: "loading" });
    try {
      const { data, error, response } = await api.GET("/admin/audit", {
        params: { query: queryOf(filters, before) },
      });
      if (response.status === 403) return settle({ kind: "forbidden" });
      if (!data) {
        // A filter the API refused says so; a cursor it refused is a failure like any other.
        const code = (error as { error?: { code?: string } } | undefined)?.error?.code;
        return settle({
          kind: "error",
          invalid: response.status === 400 && code !== "cursor_invalid",
        });
      }
      settle({ kind: "ready", page: AuditPage.parse(data) });
    } catch (error) {
      if (ticket !== latest.current) return;
      console.error("audit load failed", error);
      settle({ kind: "error", invalid: false });
    }
    // `asked` is read so a repeated "Show" makes a new load.
  }, [filters, before, asked]);

  useEffect(() => {
    void load();
  }, [load]);

  // In the commit that shows the page, not in an effect a task later: a press
  // of Older or Newer landing before that task would spend `paged` on the page
  // being left, whose container then goes with the load.
  useLayoutEffect(() => {
    if (state.kind !== "ready" || !paged.current) return;
    paged.current = false;
    shownPage.current?.focus();
  }, [state]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    setFilters(draft);
    setCursors([null]);
    setAsked((n) => n + 1);
  };
  const page = (next: (string | null)[]) => {
    paged.current = true;
    setCursors(next);
  };
  const field = (key: keyof Filters, label: string, type = "text") => (
    <Label className="grid gap-2">
      {label}
      <Input
        type={type}
        value={draft[key]}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
      />
    </Label>
  );

  return (
    <section aria-labelledby="audit-title" className="space-y-6">
      <ScreenTitle id="audit-title">{t("admin.audit.title")}</ScreenTitle>
      <Card>
        <CardContent>
          <form
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            onSubmit={apply}
            aria-label={t("admin.audit.filters")}
          >
            {field("actor", t("admin.audit.actor"))}
            {field("action", t("admin.audit.action"))}
            {field("subjectType", t("admin.audit.subjectType"))}
            {field("subjectId", t("admin.audit.subjectId"))}
            {field("from", t("admin.audit.from"), "date")}
            {field("to", t("admin.audit.to"), "date")}
            <div className="sm:col-span-2 lg:col-span-3">
              <Button type="submit">
                <Filter aria-hidden="true" />
                {t("admin.audit.apply")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      {state.kind === "loading" && <Loading>{t("admin.audit.loading")}</Loading>}
      {state.kind === "error" && (
        <Alert>{t(state.invalid ? "admin.audit.invalid" : "admin.audit.error")}</Alert>
      )}
      {state.kind === "ready" && (
        <>
          <Card>
            <CardContent>
              <div ref={shownPage} tabIndex={-1}>
                {state.page.items.length === 0 ? (
                  <p className="text-muted-foreground">{t("admin.audit.none")}</p>
                ) : (
                  <Table className="[&_td]:align-top">
                    <TableCaption>{t("admin.audit.caption")}</TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">{t("admin.account.col.when")}</TableHead>
                        <TableHead scope="col">{t("admin.account.col.who")}</TableHead>
                        <TableHead scope="col">{t("admin.audit.role")}</TableHead>
                        <TableHead scope="col">{t("admin.account.col.what")}</TableHead>
                        <TableHead scope="col">{t("admin.audit.subject")}</TableHead>
                        <TableHead scope="col">{t("admin.account.col.detail")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {state.page.items.map((row, index) => (
                        // Two rows can match in every field (one transaction's now()): the place breaks the tie.
                        <TableRow key={`${index}-${row.at}-${row.action}-${row.subjectId}`}>
                          <TableCell>{formatDateTime(locale, new Date(row.at))}</TableCell>
                          <TableCell className="min-w-28 whitespace-normal">
                            {/* No person: a shadow ban an automatic rule applied (#105). */}
                            {row.actorIdentityId === null ? (
                              t("admin.audit.actorAutomatic")
                            ) : (
                              <code className="break-all">{row.actorIdentityId}</code>
                            )}
                          </TableCell>
                          {/* The automatic rules hold no role, and never held one. */}
                          <TableCell>
                            {row.actorIdentityId === null
                              ? t("admin.audit.roleAutomatic")
                              : (row.actorRole ?? t("admin.audit.noRole"))}
                          </TableCell>
                          <TableCell>{row.action}</TableCell>
                          <TableCell className="whitespace-normal [&_code]:wrap-normal">
                            {row.accountId ? (
                              <Link className="target" to={`/accounts/${row.accountId}`}>
                                {row.subjectType} <code>{row.subjectId.slice(0, 8)}</code>
                              </Link>
                            ) : (
                              <>
                                {row.subjectType} <code>{row.subjectId.slice(0, 8)}</code>
                              </>
                            )}
                          </TableCell>
                          <TableCell className="min-w-36 whitespace-normal">
                            <AuditDetail detail={row.detail} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </CardContent>
          </Card>
          <div className="flex flex-wrap justify-between gap-3">
            <Button
              variant="outline"
              disabled={cursors.length === 1}
              onClick={() => page(cursors.slice(0, -1))}
            >
              <ChevronLeft aria-hidden="true" />
              {t("admin.audit.newer")}
            </Button>
            <Button
              variant="outline"
              disabled={state.page.next === null}
              onClick={() => page([...cursors, state.page.next])}
            >
              {t("admin.audit.older")}
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
