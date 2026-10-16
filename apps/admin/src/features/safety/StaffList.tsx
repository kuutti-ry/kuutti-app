import { formatDateTime } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import { StaffList as StaffPage } from "@kuutti/schema";
import { api } from "../../lib/api.ts";
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
    <section aria-labelledby="staff-title" className="staff">
      <div className="row">
        <ScreenTitle id="staff-title">{t("admin.staff.title")}</ScreenTitle>
        <button type="button" onClick={() => void reload()}>
          {t("admin.staff.refresh")}
        </button>
      </div>
      <p>{t("admin.staff.explain")}</p>
      {state.kind === "loading" && <p aria-busy="true">{t("admin.staff.loading")}</p>}
      {state.kind === "error" && <p role="alert">{t("admin.staff.error")}</p>}
      {state.kind === "ready" && (
        <table>
          <caption>{t("admin.staff.caption", { total: state.total })}</caption>
          <thead>
            <tr>
              <th scope="col">{t("admin.staff.col.identity")}</th>
              <th scope="col">{t("admin.staff.col.role")}</th>
              <th scope="col">{t("admin.staff.col.granted")}</th>
              <th scope="col">{t("admin.staff.col.by")}</th>
              <th scope="col">{t("admin.staff.col.lastSignIn")}</th>
            </tr>
          </thead>
          <tbody>
            {state.items.map((m) => (
              <tr key={m.identityId}>
                <td>
                  <code>{m.identityId}</code>
                </td>
                <td>{m.role}</td>
                <td>{formatDateTime(locale, new Date(m.grantedAt))}</td>
                <td>{m.grantedBy}</td>
                <td>
                  {m.lastSignInAt
                    ? formatDateTime(locale, new Date(m.lastSignInAt))
                    : t("admin.staff.never")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
