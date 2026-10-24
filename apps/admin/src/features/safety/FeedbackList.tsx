import { formatDateTime, type PlainMessageKey } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import { type FeedbackItem, type FeedbackKind, FeedbackList as FeedbackPage } from "@kuutti/schema";
import { Check, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Card, CardContent, CardTitle } from "../../components/ui/card.tsx";
import { Loading } from "../../components/ui/spinner.tsx";
import { api } from "../../lib/api.ts";
import { ScreenTitle } from "../../lib/screen-title.tsx";
import { useList } from "../../lib/use-list.ts";

// Feedback from inside the app (#171, ADR-023, rules/admin.md): what people
// sent, a bug first and praise last, each with the build the app read and the
// sender's account id; a moderator marks a row handled, which is an
// audit_log row. Keyboard first; English only (TD-17).

const KIND_LABEL: Record<FeedbackKind, PlainMessageKey> = {
  bug: "admin.feedback.kind.bug",
  idea: "admin.feedback.kind.idea",
  complaint: "admin.feedback.kind.complaint",
  praise: "admin.feedback.kind.praise",
};

export function FeedbackList() {
  const { t } = useT();
  const { state, reload, settle } = useList({
    fetchPage: () => api.GET("/admin/feedback", { params: { query: { limit: 50 } } }),
    parse: (data) => FeedbackPage.parse(data),
    what: "feedback",
  });

  // A handled row stays where it was, saying so, until the next refresh; the
  // count of what still waits goes down.
  return (
    <section aria-labelledby="feedback-title" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScreenTitle id="feedback-title">{t("admin.feedback.title")}</ScreenTitle>
        <Button variant="outline" onClick={() => void reload()}>
          <RefreshCw aria-hidden="true" />
          {t("admin.feedback.refresh")}
        </Button>
      </div>
      {state.kind === "loading" && <Loading>{t("admin.feedback.loading")}</Loading>}
      {state.kind === "error" && <Alert>{t("admin.feedback.error")}</Alert>}
      {state.kind === "ready" && (
        <>
          <p aria-live="polite" className="text-muted-foreground">
            {t("admin.feedback.total", { total: state.total })}
          </p>
          <ul className="grid gap-4">
            {state.items.map((item) => (
              <FeedbackRow key={item.id} item={item} onHandled={settle} />
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
    // A 403 is the shell's to say (#302): the row keeps its button, no failure of its own.
    const answer = await api
      .POST("/admin/feedback/{id}/handled", { params: { path: { id: item.id } } })
      .catch(() => null);
    if (answer?.response.status === 403) {
      setState("idle");
      return;
    }
    if (!answer?.data) {
      setState("failed");
      return;
    }
    setState("handled");
    onHandled();
  };

  if (state === "handled") {
    return (
      <li aria-live="polite">
        <Card className="bg-muted">
          <CardContent className="flex-row items-center gap-2 font-medium">
            <Check aria-hidden="true" className="size-4" />
            {t("admin.feedback.handled")}
          </CardContent>
        </Card>
      </li>
    );
  }
  return (
    <li>
      <Card>
        <CardContent>
          <CardTitle>{t(KIND_LABEL[item.kind])}</CardTitle>
          <p className="whitespace-pre-wrap wrap-anywhere">{item.text}</p>
          <p className="text-xs text-muted-foreground">
            {t("admin.feedback.meta", {
              version: item.appVersion,
              platform: item.platform,
              locale: item.locale,
              time: formatDateTime(locale, new Date(item.createdAt)),
              account: item.accountId.slice(0, 8),
            })}{" "}
            · <Link to={`/accounts/${item.accountId}`}>{t("admin.account.pageLink")}</Link>
          </p>
          <div className="flex flex-wrap items-center gap-3 border-t pt-3">
            {state === "failed" && <Alert>{t("admin.feedback.handleFailed")}</Alert>}
            <Button variant="outline" disabled={state === "saving"} onClick={() => void mark()}>
              <Check aria-hidden="true" />
              {t("admin.feedback.handle")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </li>
  );
}
