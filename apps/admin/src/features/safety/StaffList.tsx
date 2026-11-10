import { formatDateTime } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import { StaffList as StaffPage } from "@kuutti/schema";
import { Alert } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Card, CardContent } from "../../components/ui/card.tsx";
import { Loading } from "../../components/ui/spinner.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { api } from "../../lib/api.ts";
import { RefreshButton } from "../../lib/refresh-button.tsx";
import { ScreenTitle } from "../../lib/screen-title.tsx";
import { useList } from "../../lib/use-list.ts";

// Who holds a role (#310, admins only): the role, when and by whom it was
// granted, the last sign-in to the panel; for checking the access policy
// (#192) against what is true. Granting and revoking stay the maintainer's
// tool (ADR-006 §5). English only (TD-17).

export function StaffList() {
  const { t, locale } = useT();
  const { state, reload } = useList({
    fetchPage: () => api.GET("/admin/staff"),
    parse: (data) => {
      const { items } = StaffPage.parse(data);
      return { items, total: items.length };
    },
    what: "staff",
  });
  return (
    <section aria-labelledby="staff-title" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScreenTitle id="staff-title">{t("admin.staff.title")}</ScreenTitle>
        <RefreshButton onClick={() => void reload()}>{t("admin.staff.refresh")}</RefreshButton>
      </div>
      {state.kind === "loading" && <Loading>{t("load.loading")}</Loading>}
      {state.kind === "error" && <Alert>{t("admin.loadFailed")}</Alert>}
      {state.kind === "ready" && (
        <Card>
          <CardContent>
            <Table aria-labelledby="staff-title">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t("admin.staff.col.identity")}</TableHead>
                  <TableHead scope="col">{t("admin.staff.col.role")}</TableHead>
                  <TableHead scope="col">{t("admin.staff.col.granted")}</TableHead>
                  <TableHead scope="col">{t("admin.staff.col.by")}</TableHead>
                  <TableHead scope="col">{t("admin.staff.col.lastSignIn")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.items.map((m) => (
                  <TableRow key={m.identityId}>
                    <TableCell>
                      <code>{m.identityId}</code>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{m.role}</Badge>
                    </TableCell>
                    <TableCell>{formatDateTime(locale, new Date(m.grantedAt))}</TableCell>
                    <TableCell>{m.grantedBy}</TableCell>
                    <TableCell>
                      {m.lastSignInAt
                        ? formatDateTime(locale, new Date(m.lastSignInAt))
                        : t("admin.staff.never")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
