import { useT } from "@kuutti/i18n/react";
import { AdminPond, AdminPondList } from "@kuutti/schema";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Alert } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Card, CardContent } from "../../components/ui/card.tsx";
import { Loading } from "../../components/ui/spinner.tsx";
import { api } from "../../lib/api.ts";
import { Dialog } from "../../lib/dialog.tsx";
import { ScreenTitle } from "../../lib/screen-title.tsx";
import { useList } from "../../lib/use-list.ts";
import { type Refusals, useSend } from "../safety/index.ts";

// The switch that opens matching (#500, ADR-060 §1 and §2, admins only): one,
// for the whole country, since there is one pond (ADR-061 §8), whose row the
// routes still name. Matching opens when an admin says so here, and nothing else
// opens or closes it. A confirm step says the effect in words; the API writes
// the audit row. No reason is asked: an audit row's detail holds no words, and
// the act is its own reason. A turned switch updates in place, nothing else on
// the screen moves. English only (TD-17); keyboard first.

const REFUSALS: Refusals = { codes: {}, failed: "admin.matching.failed" };

export function MatchingSwitch() {
  const { t } = useT();
  // What the last press did, said in a live region that is always there, so
  // the first press is announced too. Heard and never drawn: the badge turns
  // and the button changes its name.
  const [said, setSaid] = useState<boolean | null>(null);
  const [turning, setTurning] = useState<AdminPond | null>(null);
  const { state, reload, update } = useList({
    fetchPage: () => api.GET("/admin/ponds"),
    parse: (data) => {
      const { items } = AdminPondList.parse(data);
      return { items, total: items.length };
    },
    what: "matching",
  });
  const pond = state.kind === "ready" ? state.items[0] : undefined;

  return (
    <section aria-labelledby="matching-title" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScreenTitle id="matching-title">{t("admin.matching.title")}</ScreenTitle>
        <Button variant="outline" onClick={() => void reload()}>
          <RefreshCw aria-hidden="true" />
          {t("admin.matching.refresh")}
        </Button>
      </div>
      <p aria-live="polite" className="sr-only">
        {said === true && t("admin.matching.opened")}
        {said === false && t("admin.matching.closedNow")}
      </p>
      {state.kind === "loading" && <Loading>{t("admin.matching.loading")}</Loading>}
      {state.kind === "error" && <Alert>{t("admin.loadFailed")}</Alert>}
      {pond && (
        <Card className="py-0 sm:py-0">
          {/* Wraps at a phone's width, so the press is never out of sight. */}
          <CardContent className="flex-row flex-wrap items-center gap-x-4 gap-y-2 py-3">
            {/* The word says it, the fill only repeats it: never colour alone. */}
            <Badge variant={pond.matchingOpen ? "default" : "secondary"}>
              {t(pond.matchingOpen ? "admin.matching.open" : "admin.matching.closed")}
            </Badge>
            <Button
              variant="outline"
              className="ms-auto"
              onClick={() => {
                setSaid(null);
                setTurning(pond);
              }}
            >
              {t(pond.matchingOpen ? "admin.matching.apply.close" : "admin.matching.apply.open")}
            </Button>
          </CardContent>
        </Card>
      )}
      {turning && (
        <TurnStep
          pond={turning}
          onCancel={() => setTurning(null)}
          onDone={async (turned) => {
            setTurning(null);
            setSaid(turned.matchingOpen);
            update((items) => items.map((item) => (item.id === turned.id ? turned : item)));
          }}
        />
      )}
    </section>
  );
}

/** The confirm step: what the press will do, in words, before it is sent. */
function TurnStep({
  pond,
  onCancel,
  onDone,
}: {
  pond: AdminPond;
  onCancel: () => void;
  onDone: (pond: AdminPond) => Promise<void>;
}) {
  const { t } = useT();
  const open = !pond.matchingOpen;
  // A 403 is the shell's to say (#302): the step closes with no words of its own.
  const { sending, refused, send } = useSend({
    answer: AdminPond,
    refusals: REFUSALS,
    onShell: onCancel,
    onDone,
  });

  return (
    <Dialog
      title={t(open ? "admin.matching.confirm.open.title" : "admin.matching.confirm.close.title")}
      onClose={onCancel}
    >
      <div className="grid gap-4">
        <p>
          {t(open ? "admin.matching.confirm.open.effect" : "admin.matching.confirm.close.effect")}
        </p>
        {refused && <Alert>{t(refused)}</Alert>}
        <div className="flex flex-wrap gap-3">
          <Button
            variant={open ? "default" : "destructive"}
            aria-busy={sending || undefined}
            onClick={() =>
              void send(() =>
                api.POST("/admin/ponds/{id}/matching", {
                  params: { path: { id: pond.id } },
                  body: { open },
                }),
              )
            }
          >
            {t(open ? "admin.matching.apply.open" : "admin.matching.apply.close")}
          </Button>
          <Button variant="outline" onClick={onCancel}>
            {t("admin.matching.cancel")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
