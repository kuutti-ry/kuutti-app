import { formatDateTime } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import {
  AdminAccount,
  type AdminAccountPhoto,
  type SanctionEntry,
  SanctionList,
} from "@kuutti/schema";
import { Image, Search } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Card, CardContent, CardTitle } from "../../components/ui/card.tsx";
import { DescriptionList } from "../../components/ui/description-list.tsx";
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
import { usePhotoOnRequest } from "./photo-on-request.ts";
import { Sanctions } from "./Sanctions.tsx";

// A person's page in the panel (#306): one account by its id, never a
// search. Every open is an audit row on the API's side (account.view), so
// the page asks once per id, StrictMode's second effect run included; a
// photo is fetched only when the moderator asks to see it (#253), one
// photo.view row per look. An erased account shows its deletion date and
// nothing else. The sanctions and their actions are #308's (Sanctions.tsx);
// after one, the page is read again in place, which is another look and
// another account.view row. English only (TD-17); keyboard first.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The way to a page: an account id, typed or pasted, and nothing else to search by. */
export function AccountLookup() {
  const { t } = useT();
  const navigate = useNavigate();
  const [id, setId] = useState("");
  const [invalid, setInvalid] = useState(false);
  const open = (event: FormEvent) => {
    event.preventDefault();
    const value = id.trim();
    if (!UUID.test(value)) return setInvalid(true);
    navigate(`/accounts/${value.toLowerCase()}`);
  };
  return (
    <section aria-labelledby="lookup-title" className="space-y-6">
      <ScreenTitle id="lookup-title">{t("admin.account.lookupTitle")}</ScreenTitle>
      <p className="max-w-prose text-muted-foreground">{t("admin.account.lookupExplain")}</p>
      <Card className="max-w-2xl">
        <CardContent>
          <form className="grid gap-4" onSubmit={open}>
            {invalid && <Alert>{t("admin.account.notAnId")}</Alert>}
            <div className="grid gap-2">
              <Label htmlFor="lookup-id">{t("admin.account.id")}</Label>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Input
                  id="lookup-id"
                  value={id}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  aria-invalid={invalid || undefined}
                  onChange={(event) => {
                    setId(event.target.value);
                    setInvalid(false);
                  }}
                />
                <Button type="submit">
                  <Search aria-hidden="true" />
                  {t("admin.account.open")}
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}

type State =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "missing" }
  | { kind: "forbidden" }
  | { kind: "ready"; page: AdminAccount; sanctions: SanctionEntry[] | null };

export function AccountPage() {
  const { t, locale } = useT();
  const { id = "" } = useParams();
  const [state, setState] = useState<State>({ kind: "loading" });
  const when = (at: string | null) => (at ? formatDateTime(locale, new Date(at)) : "–");

  const read = useCallback(async (): Promise<State> => {
    try {
      const { data, response } = await api.GET("/admin/accounts/{id}", {
        params: { path: { id } },
      });
      // A 403 is the shell's to say (#302).
      if (response.status === 403) return { kind: "forbidden" };
      if (response.status === 404 || response.status === 400) return { kind: "missing" };
      if (!data) return { kind: "error" };
      const page = AdminAccount.parse(data);
      // An erased account shows nothing more, so nothing more is asked for.
      if (page.state === "deleted") return { kind: "ready", page, sanctions: [] };
      // The sanctions come from their own route (#307); a failure there leaves the rest of the page.
      const listed = await api
        .GET("/admin/accounts/{id}/sanctions", { params: { path: { id } } })
        .catch(() => null);
      const parsed = SanctionList.safeParse(listed?.data);
      const sanctions = parsed.success ? parsed.data.items : null;
      return { kind: "ready", page, sanctions };
    } catch (error) {
      console.error("account page load failed", error);
      return { kind: "error" };
    }
  }, [id]);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    setState(await read());
  }, [read]);

  // After a sanction (#308): read again without the loading step, so the
  // page and the focus stay where they are. Only a page read in full
  // replaces it: a failure keeps what is shown and the line that says what
  // was done, so nobody applies it twice; a refusal there is the shell's.
  const refresh = useCallback(async () => {
    const next = await read();
    if (next.kind === "ready") setState(next);
  }, [read]);

  // Each open is an account.view row: once per id, though StrictMode runs the effect twice.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (opened.current === id) return;
    opened.current = id;
    void load();
  }, [id, load]);

  const title = t("admin.account.title", { account: id.slice(0, 8) });
  if (state.kind !== "ready") {
    return (
      <section aria-labelledby="account-title" className="space-y-6">
        <ScreenTitle id="account-title">{title}</ScreenTitle>
        {state.kind === "loading" && <Loading>{t("admin.account.loading")}</Loading>}
        {state.kind === "error" && <Alert>{t("admin.account.error")}</Alert>}
        {state.kind === "missing" && (
          <p className="text-muted-foreground">{t("admin.account.missing")}</p>
        )}
      </section>
    );
  }
  const { page, sanctions } = state;
  if (page.state === "deleted") {
    return (
      <section aria-labelledby="account-title" className="space-y-6">
        <ScreenTitle id="account-title">{title}</ScreenTitle>
        {/* The whole id, for copying, close under the heading. */}
        <p className="-mt-4 text-sm text-muted-foreground">
          <code>{page.id}</code>
        </p>
        <Card>
          <CardContent>
            <CardTitle>{t("admin.account.standingTitle")}</CardTitle>
            <DescriptionList>
              <dt>{t("admin.account.state")}</dt>
              <dd>{page.state}</dd>
              <dt>{t("admin.account.deleted")}</dt>
              <dd>{when(page.deletedAt)}</dd>
            </DescriptionList>
          </CardContent>
        </Card>
      </section>
    );
  }
  return (
    <section aria-labelledby="account-title" className="space-y-6">
      <ScreenTitle id="account-title">{title}</ScreenTitle>
      {/* The whole id, for copying, close under the heading. */}
      <p className="-mt-4 text-sm text-muted-foreground">
        <code>{page.id}</code>
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent>
            <CardTitle>{t("admin.account.standingTitle")}</CardTitle>
            <DescriptionList>
              <dt>{t("admin.account.state")}</dt>
              <dd>
                {page.state} · {when(page.stateChangedAt)}
              </dd>
              <dt>{t("admin.account.standing")}</dt>
              <dd>
                {page.standing} · {when(page.standingChangedAt)}
                {page.suspensionEndsAt &&
                  ` · ${t("admin.account.until", { time: when(page.suspensionEndsAt) })}`}
              </dd>
              <dt>{t("admin.account.registered")}</dt>
              <dd>{when(page.registeredAt)}</dd>
            </DescriptionList>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <CardTitle>{t("admin.account.profileTitle")}</CardTitle>
            {page.profile ? (
              <DescriptionList>
                <dt>{t("admin.account.name")}</dt>
                <dd>{page.profile.displayName}</dd>
                <dt>{t("admin.account.age")}</dt>
                <dd>{page.age ?? "–"}</dd>
                <dt>{t("admin.account.gender")}</dt>
                <dd>{page.gender ?? "–"}</dd>
                <dt>{t("admin.account.pond")}</dt>
                <dd>{page.pond ?? "–"}</dd>
                <dt>{t("admin.account.bio")}</dt>
                <dd>
                  {page.profile.bio ??
                    (page.profile.bioPreset
                      ? t("admin.account.bioPreset", { preset: page.profile.bioPreset })
                      : "–")}
                </dd>
                {page.profile.prompts.map((p) => (
                  <div key={p.key}>
                    <dt>
                      <code>{p.key}</code>
                    </dt>
                    <dd>{p.answer}</dd>
                  </div>
                ))}
                {Object.entries(page.profile.fields).map(([key, value]) => (
                  <div key={key}>
                    <dt>
                      <code>{key}</code>
                    </dt>
                    <dd>{Array.isArray(value) ? value.join(", ") : String(value)}</dd>
                  </div>
                ))}
              </DescriptionList>
            ) : (
              <p className="text-muted-foreground">{t("admin.account.noProfile")}</p>
            )}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardContent>
          <CardTitle>{t("admin.account.photosTitle")}</CardTitle>
          {page.photos.length === 0 ? (
            <p className="text-muted-foreground">{t("admin.account.none")}</p>
          ) : (
            <ul className="grid gap-4 items-start sm:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]">
              {page.photos.map((photo) => (
                <PersonPhoto key={photo.id} photo={photo} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="gap-4">
          <CardTitle>{t("admin.account.sanctionsTitle")}</CardTitle>
          <Sanctions accountId={page.id} items={sanctions} onChanged={refresh} />
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <CardTitle>{t("admin.account.feedbackTitle")}</CardTitle>
          {page.feedback.length === 0 ? (
            <p className="text-muted-foreground">{t("admin.account.none")}</p>
          ) : (
            <ul className="grid gap-2">
              {page.feedback.map((f) => (
                <li key={`${f.at}-${f.kind}`} className="space-y-1 rounded-lg border px-3 py-2">
                  <p className="text-muted-foreground">
                    <strong className="text-foreground">{f.kind}</strong> · {when(f.at)}
                    {f.handledAt && ` · ${t("admin.account.handled", { time: when(f.handledAt) })}`}
                  </p>
                  <p className="whitespace-pre-wrap wrap-anywhere">{f.text}</p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <CardTitle>{t("admin.account.auditTitle")}</CardTitle>
          {page.audit.length === 0 ? (
            <p className="text-muted-foreground">{t("admin.account.none")}</p>
          ) : (
            <Table className="[&_td]:align-top">
              <TableCaption>{t("admin.account.auditCaption")}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t("admin.account.col.when")}</TableHead>
                  <TableHead scope="col">{t("admin.account.col.who")}</TableHead>
                  <TableHead scope="col">{t("admin.account.col.what")}</TableHead>
                  <TableHead scope="col">{t("admin.account.col.detail")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.audit.map((row) => (
                  <TableRow key={`${row.at}-${row.action}-${row.subjectId}`}>
                    <TableCell>{when(row.at)}</TableCell>
                    <TableCell>
                      {/* No person: a shadow ban an automatic rule applied (#105). */}
                      {row.actorIdentityId === null ? (
                        t("admin.audit.actorAutomatic")
                      ) : (
                        <code>{row.actorIdentityId.slice(0, 8)}</code>
                      )}
                    </TableCell>
                    <TableCell>{row.action}</TableCell>
                    <TableCell className="min-w-48 whitespace-normal">
                      <AuditDetail detail={row.detail} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/** One photo, hidden until asked (photo-on-request.ts): its card variant, as others see it. */
function PersonPhoto({ photo }: { photo: AdminAccountPhoto }) {
  const { t, locale } = useT();
  const { url, failed, pending, show, picture } = usePhotoOnRequest(() =>
    api.GET("/admin/photos/{id}/card", { params: { path: { id: photo.id } } }),
  );
  const uploaded = formatDateTime(locale, new Date(photo.uploadedAt));
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3">
      <p className="text-muted-foreground">
        {photo.state}
        {photo.rejectionReason && ` · ${photo.rejectionReason}`} · {uploaded}
      </p>
      {url ? (
        <img
          ref={picture}
          tabIndex={-1}
          src={url}
          alt={t("admin.account.image", { state: photo.state, time: uploaded })}
          width={240}
          height={320}
          className="h-auto w-full max-w-60 rounded-md"
        />
      ) : (
        <>
          {failed && <Alert>{t("admin.account.photoFailed")}</Alert>}
          <Button
            variant="outline"
            className="self-start"
            aria-busy={pending || undefined}
            onClick={() => void show()}
          >
            <Image aria-hidden="true" />
            {t("admin.account.showPhoto")}
          </Button>
        </>
      )}
    </li>
  );
}
