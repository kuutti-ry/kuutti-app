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

// The ponds and their switches (#500, ADR-060 §1 and §2, admins only): matching
// opens in a pond when an admin says so here, and nothing else opens or closes
// it. A confirm step says the effect in words; the API writes the audit row.
// No reason is asked: an audit row's detail holds no words, and the act is its
// own reason. A turned switch updates its pond in place, nothing else on the
// screen moves. English only (TD-17); keyboard first.

const REFUSALS: Refusals = { codes: {}, failed: "admin.ponds.failed" };

export function PondList() {
  const { t } = useT();
  // What the last press did, said in a live region that is always there, so
  // the first press is announced too.
  const [said, setSaid] = useState<AdminPond | null>(null);
  const [turning, setTurning] = useState<AdminPond | null>(null);
  const { state, reload, update } = useList({
    fetchPage: () => api.GET("/admin/ponds"),
    parse: (data) => {
      const { items } = AdminPondList.parse(data);
      return { items, total: items.length };
    },
    what: "ponds",
  });

  return (
    <section aria-labelledby="ponds-title" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScreenTitle id="ponds-title">{t("admin.ponds.title")}</ScreenTitle>
        <Button variant="outline" onClick={() => void reload()}>
          <RefreshCw aria-hidden="true" />
          {t("admin.ponds.refresh")}
        </Button>
      </div>
      <p className="max-w-prose text-muted-foreground">{t("admin.ponds.explain")}</p>
      <p aria-live="polite" className="font-medium empty:sr-only">
        {said?.matchingOpen === true && t("admin.ponds.opened", { pond: said.name })}
        {said?.matchingOpen === false && t("admin.ponds.closedNow", { pond: said.name })}
      </p>
      {state.kind === "loading" && <Loading>{t("admin.ponds.loading")}</Loading>}
      {state.kind === "error" && <Alert>{t("admin.ponds.error")}</Alert>}
      {state.kind === "ready" && (
        <>
          <p className="text-muted-foreground">
            {t("admin.ponds.caption", { total: state.total })}
          </p>
          <ul className="grid gap-3">
            {state.items.map((pond) => (
              <li key={pond.id}>
                <Card className="py-0 sm:py-0">
                  {/* Wraps at a phone's width, so the press is never out of sight. */}
                  <CardContent className="flex-row flex-wrap items-center gap-x-4 gap-y-2 py-3">
                    <span className="font-medium wrap-anywhere">{pond.name}</span>
                    {/* The word says it, the fill only repeats it: never colour alone. */}
                    <Badge variant={pond.matchingOpen ? "default" : "secondary"}>
                      {t(pond.matchingOpen ? "admin.ponds.open" : "admin.ponds.closed")}
                    </Badge>
                    <Button
                      variant="outline"
                      className="ms-auto"
                      aria-label={
                        pond.matchingOpen
                          ? t("admin.ponds.turnOff", { pond: pond.name })
                          : t("admin.ponds.turnOn", { pond: pond.name })
                      }
                      onClick={() => {
                        setSaid(null);
                        setTurning(pond);
                      }}
                    >
                      {t(pond.matchingOpen ? "admin.ponds.apply.close" : "admin.ponds.apply.open")}
                    </Button>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
      {turning && (
        <TurnStep
          pond={turning}
          onCancel={() => setTurning(null)}
          onDone={async (pond) => {
            setTurning(null);
            setSaid(pond);
            update((items) => items.map((item) => (item.id === pond.id ? pond : item)));
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
  const title = open
    ? t("admin.ponds.confirm.open.title", { pond: pond.name })
    : t("admin.ponds.confirm.close.title", { pond: pond.name });

  return (
    <Dialog title={title} onClose={onCancel}>
      <div className="grid gap-4">
        <p>{t(open ? "admin.ponds.confirm.open.effect" : "admin.ponds.confirm.close.effect")}</p>
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
            {t(open ? "admin.ponds.apply.open" : "admin.ponds.apply.close")}
          </Button>
          <Button variant="outline" onClick={onCancel}>
            {t("admin.ponds.cancel")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
