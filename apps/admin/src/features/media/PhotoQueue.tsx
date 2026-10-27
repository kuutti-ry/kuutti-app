import { formatDateTime } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import {
  type ModeratorRejectionReason,
  type PhotoReviewItem,
  PhotoReviewQueue,
  PhotoUrlResponse,
} from "@kuutti/schema";
import { Check, EyeOff, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Alert } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Card, CardContent } from "../../components/ui/card.tsx";
import { Label } from "../../components/ui/label.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { Loading } from "../../components/ui/spinner.tsx";
import { api } from "../../lib/api.ts";
import { ScreenTitle } from "../../lib/screen-title.tsx";
import { useList } from "../../lib/use-list.ts";
import { REJECTION_REASONS } from "./reasons.ts";

// The photo review queue (#49, rules/admin.md): what a person decides about
// the photos the automatic check would not approve. Keyboard first: every
// control is a button or a labelled select, the image has its alt text, and
// a decided item announces itself. English only (TD-17).

export function PhotoQueue() {
  const { t } = useT();
  const { state, reload, settle } = useList({
    fetchPage: () => api.GET("/admin/photos/queue", { params: { query: { limit: 20 } } }),
    parse: (data) => PhotoReviewQueue.parse(data),
    what: "queue",
  });

  // A decided item stays where it was, saying what was decided, until the
  // next refresh: the moderator sees the result of the click, and the count
  // of what is still waiting goes down.
  return (
    <section aria-labelledby="queue-title" className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <ScreenTitle id="queue-title">{t("admin.queue.title")}</ScreenTitle>
        <Button variant="outline" onClick={() => void reload()}>
          <RefreshCw aria-hidden="true" />
          {t("admin.queue.refresh")}
        </Button>
      </header>
      {state.kind === "loading" && <Loading>{t("admin.queue.loading")}</Loading>}
      {state.kind === "error" && <Alert>{t("admin.queue.error")}</Alert>}
      {state.kind === "ready" && (
        <>
          <p aria-live="polite" className="text-muted-foreground">
            {t("admin.queue.total", { total: state.total })}
          </p>
          <ul className="grid gap-4">
            {state.items.map((item) => (
              <QueueItem key={item.photoId} item={item} onDecided={settle} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

type ItemState =
  | { kind: "idle" }
  // No reason until one is chosen on purpose (#250): a preset one would tell a
  // person their photo was rejected for it after one careless click.
  | { kind: "rejecting"; reason: ModeratorRejectionReason | null }
  | { kind: "saving" }
  | { kind: "decided"; decision: "approved" | "rejected" }
  | { kind: "failed" };

function QueueItem({ item, onDecided }: { item: PhotoReviewItem; onDecided: () => void }) {
  const { t, locale } = useT();
  const [state, setState] = useState<ItemState>({ kind: "idle" });
  const [url, setUrl] = useState<string | null>(null);
  // A sensitive picture is not even fetched until the moderator chooses to look (#253).
  const [shown, setShown] = useState(!item.sensitive);

  // The card through a signed URL: one audit row per view, on the API's side.
  // An item that goes away cancels its request, so nothing goes out after it;
  // a request that fails leaves the picture loading, as a refused URL does.
  useEffect(() => {
    if (!shown) return;
    const controller = new AbortController();
    void api
      .GET("/admin/photos/{id}/card", {
        params: { path: { id: item.photoId } },
        signal: controller.signal,
      })
      .then(({ data }) => {
        if (data) setUrl(PhotoUrlResponse.parse(data).url);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [item.photoId, shown]);

  const decide = async (
    body: { decision: "approve" } | { decision: "reject"; reason: ModeratorRejectionReason },
  ) => {
    setState({ kind: "saving" });
    // A network failure is a decision not saved: never a saving state that
    // nothing will end. A 403 is the shell's to say (#302): the item goes back
    // to its buttons without a failure of its own.
    const answer = await api
      .POST("/admin/photos/{id}/decision", { params: { path: { id: item.photoId } }, body })
      .catch(() => null);
    if (answer?.response.status === 403) {
      setState({ kind: "idle" });
      return;
    }
    if (!answer?.data) {
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
      <li aria-live="polite">
        <Card className="bg-muted">
          <CardContent className="flex-row items-center gap-2 font-medium">
            {state.decision === "approved" ? (
              <Check aria-hidden="true" className="size-4" />
            ) : (
              <X aria-hidden="true" className="size-4" />
            )}
            {t("admin.queue.decided", { decision: state.decision })}
          </CardContent>
        </Card>
      </li>
    );
  }

  return (
    <li>
      <Card>
        {/* The decision beside the photo on a wide screen, so neither scrolls away from the other. */}
        <CardContent className="grid gap-4 sm:grid-cols-[minmax(10rem,16rem)_1fr]">
          <figure className="space-y-2">
            {!shown ? (
              <div className="flex aspect-3/4 flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-muted p-4 text-center">
                <EyeOff aria-hidden="true" className="size-6 text-muted-foreground" />
                <p>{t("admin.queue.sensitive")}</p>
                <Button variant="outline" onClick={() => setShown(true)}>
                  {t("admin.queue.show")}
                </Button>
              </div>
            ) : url ? (
              <img
                src={url}
                alt={t("admin.queue.image")}
                width={400}
                height={533}
                className="block h-auto w-full rounded-md"
              />
            ) : (
              <div className="flex aspect-3/4 items-center justify-center rounded-md bg-muted">
                <Loading>{t("admin.queue.imageLoading")}</Loading>
              </div>
            )}
            <figcaption className="text-xs text-muted-foreground">
              {t("admin.queue.uploaded", { time: uploaded })} ·{" "}
              {t("admin.queue.account", { account: item.accountId.slice(0, 8) })} ·{" "}
              <Link to={`/accounts/${item.accountId}`}>{t("admin.account.pageLink")}</Link>
            </figcaption>
          </figure>
          <div className="flex flex-col gap-4">
            <div className="space-y-2">
              {item.appealed && <Badge variant="secondary">{t("admin.queue.appealed")}</Badge>}
              <h3 className="font-semibold">{t("admin.queue.labels")}</h3>
              {notChecked ? (
                <p className="text-muted-foreground">{t("admin.queue.notChecked")}</p>
              ) : (
                <>
                  <p>{t("admin.queue.faces", { faces: item.faces })}</p>
                  {item.labels.length === 0 ? (
                    <p className="text-muted-foreground">{t("admin.queue.noLabels")}</p>
                  ) : (
                    <ul className="list-disc space-y-0.5 ps-5">
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
            <div className="flex flex-wrap items-end gap-3 border-t pt-4">
              {state.kind === "failed" && <Alert>{t("admin.queue.decisionFailed")}</Alert>}
              {state.kind === "rejecting" ? (
                <form
                  className="flex w-full flex-wrap items-end gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (state.reason) void decide({ decision: "reject", reason: state.reason });
                  }}
                >
                  <Label className="grid w-full gap-2 sm:w-auto">
                    {t("admin.queue.reason.label")}
                    <NativeSelect
                      required
                      value={state.reason ?? ""}
                      onChange={(event) =>
                        setState({
                          kind: "rejecting",
                          reason: event.target.value as ModeratorRejectionReason,
                        })
                      }
                    >
                      <option value="" disabled>
                        {t("admin.queue.reason.choose")}
                      </option>
                      {REJECTION_REASONS.map((reason) => (
                        <option key={reason.value} value={reason.value}>
                          {t(reason.label)}
                        </option>
                      ))}
                    </NativeSelect>
                  </Label>
                  <Button type="submit" variant="destructive" disabled={!state.reason}>
                    {t("admin.queue.confirmReject")}
                  </Button>
                  <Button variant="outline" onClick={() => setState({ kind: "idle" })}>
                    {t("admin.queue.cancel")}
                  </Button>
                </form>
              ) : (
                <>
                  <Button
                    disabled={state.kind === "saving"}
                    onClick={() => void decide({ decision: "approve" })}
                  >
                    <Check aria-hidden="true" />
                    {t("admin.queue.approve")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={state.kind === "saving"}
                    onClick={() => setState({ kind: "rejecting", reason: null })}
                  >
                    <X aria-hidden="true" />
                    {t("admin.queue.reject")}
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </li>
  );
}
