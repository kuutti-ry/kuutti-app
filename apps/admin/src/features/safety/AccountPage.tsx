import { formatDateTime } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import {
  AdminAccount,
  type AdminAccountPhoto,
  PhotoUrlResponse,
  type SanctionEntry,
  SanctionList,
} from "@kuutti/schema";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../../lib/api.ts";
import { ScreenTitle } from "../../lib/screen-title.tsx";
import { AuditDetail } from "./audit-detail.tsx";
import { Sanctions } from "./Sanctions.tsx";

// A person's page in the panel (#306): one account by its id, never a
// search. Every open is an audit row on the API's side (account.view), so
// the page asks once per id, StrictMode's second effect run included; a
// photo is fetched only when the moderator asks to see it (#253), one
// photo.view row per look. An erased account shows its deletion date and
// nothing else. The sanctions and their actions are #308's (Sanctions.tsx);
// after one, the page is read again in place, which is another look and
// another account.view row. English only (TD-17); plain HTML, keyboard first.

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
    <section aria-labelledby="lookup-title">
      <ScreenTitle id="lookup-title">{t("admin.account.lookupTitle")}</ScreenTitle>
      <p>{t("admin.account.lookupExplain")}</p>
      <form className="actions" onSubmit={open}>
        {invalid && <p role="alert">{t("admin.account.notAnId")}</p>}
        <label htmlFor="lookup-id">{t("admin.account.id")}</label>
        <input
          id="lookup-id"
          value={id}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setId(event.target.value);
            setInvalid(false);
          }}
        />
        <button type="submit">{t("admin.account.open")}</button>
      </form>
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
      <section aria-labelledby="account-title">
        <ScreenTitle id="account-title">{title}</ScreenTitle>
        {state.kind === "loading" && <p aria-busy="true">{t("admin.account.loading")}</p>}
        {state.kind === "error" && <p role="alert">{t("admin.account.error")}</p>}
        {state.kind === "missing" && <p>{t("admin.account.missing")}</p>}
      </section>
    );
  }
  const { page, sanctions } = state;
  if (page.state === "deleted") {
    return (
      <section aria-labelledby="account-title" className="person">
        <ScreenTitle id="account-title">{title}</ScreenTitle>
        <p>
          <code>{page.id}</code>
        </p>
        <h3>{t("admin.account.standingTitle")}</h3>
        <dl>
          <dt>{t("admin.account.state")}</dt>
          <dd>{page.state}</dd>
          <dt>{t("admin.account.deleted")}</dt>
          <dd>{when(page.deletedAt)}</dd>
        </dl>
      </section>
    );
  }
  return (
    <section aria-labelledby="account-title" className="person">
      <ScreenTitle id="account-title">{title}</ScreenTitle>
      <p>
        <code>{page.id}</code>
      </p>
      <h3>{t("admin.account.standingTitle")}</h3>
      <dl>
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
      </dl>
      <h3>{t("admin.account.profileTitle")}</h3>
      {page.profile ? (
        <dl>
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
        </dl>
      ) : (
        <p>{t("admin.account.noProfile")}</p>
      )}
      <h3>{t("admin.account.photosTitle")}</h3>
      {page.photos.length === 0 ? (
        <p>{t("admin.account.none")}</p>
      ) : (
        <ul className="queue">
          {page.photos.map((photo) => (
            <PersonPhoto key={photo.id} photo={photo} />
          ))}
        </ul>
      )}
      <h3>{t("admin.account.sanctionsTitle")}</h3>
      <Sanctions accountId={page.id} items={sanctions} onChanged={refresh} />
      <h3>{t("admin.account.feedbackTitle")}</h3>
      {page.feedback.length === 0 ? (
        <p>{t("admin.account.none")}</p>
      ) : (
        <ul>
          {page.feedback.map((f) => (
            <li key={`${f.at}-${f.kind}`}>
              <strong>{f.kind}</strong> · {when(f.at)}
              {f.handledAt && ` · ${t("admin.account.handled", { time: when(f.handledAt) })}`}
              <br />
              {f.text}
            </li>
          ))}
        </ul>
      )}
      <h3>{t("admin.account.auditTitle")}</h3>
      {page.audit.length === 0 ? (
        <p>{t("admin.account.none")}</p>
      ) : (
        <table>
          <caption>{t("admin.account.auditCaption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("admin.account.col.when")}</th>
              <th scope="col">{t("admin.account.col.who")}</th>
              <th scope="col">{t("admin.account.col.what")}</th>
              <th scope="col">{t("admin.account.col.detail")}</th>
            </tr>
          </thead>
          <tbody>
            {page.audit.map((row) => (
              <tr key={`${row.at}-${row.action}-${row.subjectId}`}>
                <td>{when(row.at)}</td>
                <td>
                  <code>{row.actorIdentityId.slice(0, 8)}</code>
                </td>
                <td>{row.action}</td>
                <td>
                  <AuditDetail detail={row.detail} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * One photo, hidden until asked: the request is the audit row (photo.view),
 * so one press is one look, and the picture takes the focus the button had.
 * The button stays enabled while it asks, so a failure leaves the focus on it
 * (a disabled button loses it); a second press is a no-op.
 */
function PersonPhoto({ photo }: { photo: AdminAccountPhoto }) {
  const { t, locale } = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const asking = useRef(false);
  const picture = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (url) picture.current?.focus();
  }, [url]);
  const uploaded = formatDateTime(locale, new Date(photo.uploadedAt));
  const show = async () => {
    if (asking.current) return;
    asking.current = true;
    setPending(true);
    setFailed(false);
    const answer = await api
      .GET("/admin/photos/{id}/card", { params: { path: { id: photo.id } } })
      .catch(() => null);
    asking.current = false;
    setPending(false);
    // A 403 is the shell's to say (#302): the button stays, with no failure of its own.
    if (answer?.response.status === 403) return;
    const parsed = PhotoUrlResponse.safeParse(answer?.data);
    if (!parsed.success) return setFailed(true);
    setUrl(parsed.data.url);
  };
  return (
    <li className="item">
      <p>
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
        />
      ) : (
        <>
          {failed && <p role="alert">{t("admin.account.photoFailed")}</p>}
          <button type="button" aria-busy={pending || undefined} onClick={() => void show()}>
            {t("admin.account.showPhoto")}
          </button>
        </>
      )}
    </li>
  );
}
