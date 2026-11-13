import { formatDateTime } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import {
  AdminAnnouncement,
  AdminAnnouncementList,
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_TITLE_MAX,
  type AnnouncementDraft,
  type AnnouncementReach,
} from "@kuutti/schema";
import {
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Card, CardContent } from "../../components/ui/card.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { Loading } from "../../components/ui/spinner.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { api } from "../../lib/api.ts";
import { Dialog } from "../../lib/dialog.tsx";
import { RefreshButton } from "../../lib/refresh-button.tsx";
import { ScreenTitle } from "../../lib/screen-title.tsx";
import { useList } from "../../lib/use-list.ts";
import { type Refusals, useSend, useStatusFocus } from "../safety/index.ts";

// Announcements to everybody (#573, ADR-068 §2, admins only): one admin
// writes one in English and Finnish, and in Swedish or not; another admin
// approves it, and only then does it go, at once, as a notice in the app to
// every account, an email to the confirmed addresses and a push. The one who
// wrote it cannot approve it: the screen leaves the button out for them and
// the API refuses it. Before then either may delete it; nothing takes a sent
// one back. The confirm steps say the effect in words, with how many it
// reaches; the API writes the audit rows. English only (TD-17).

type Language = "en" | "fi" | "sv";
const LANGUAGES: readonly Language[] = ["en", "fi", "sv"];
const LANGUAGE_NAMES = {
  en: "admin.announcements.language.en",
  fi: "admin.announcements.language.fi",
  sv: "admin.announcements.language.sv",
} as const;

type Words = { title: string; body: string };
type Draft = Record<Language, Words>;
const EMPTY: Draft = {
  en: { title: "", body: "" },
  fi: { title: "", body: "" },
  sv: { title: "", body: "" },
};

/** What the form says is wrong before anything is sent. */
type Problem = "missing" | "swedishHalf";

/** The draft as the API takes it, or what is wrong with it: Swedish whole or not at all. */
export function draftOf(draft: Draft): AnnouncementDraft | Problem {
  const filled = (words: Words) => words.title.trim() !== "" && words.body.trim() !== "";
  if (!filled(draft.en) || !filled(draft.fi)) return "missing";
  const sv = draft.sv;
  const some = sv.title.trim() !== "" || sv.body.trim() !== "";
  if (some && !filled(sv)) return "swedishHalf";
  return { en: draft.en, fi: draft.fi, ...(some ? { sv } : {}) };
}

const WRITE_REFUSALS: Refusals = {
  codes: {
    text_contact_details: "admin.announcements.contactDetails",
    validation_failed: "admin.announcements.invalid",
  },
  failed: "admin.announcements.failed",
};
const APPROVE_REFUSALS: Refusals = {
  codes: {
    own_announcement: "admin.announcements.ownRefused",
    announcement_sent: "admin.announcements.sentAlready",
  },
  failed: "admin.announcements.failed",
};
const DELETE_REFUSALS: Refusals = {
  codes: { announcement_sent: "admin.announcements.sentAlready" },
  failed: "admin.announcements.failed",
};
/** A deletion answers 204 with no body: its success is the status, made a value here. */
const Deleted = z.object({ deleted: z.literal(true) });

type Said = "saved" | "sent" | "deleted";

export function Announcements() {
  const { t } = useT();
  // What the last act did, in a live region that is always there.
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [said, setSaid] = useState<Said | null>(null);
  const status = useStatusFocus(said === "sent" || said === "deleted");
  const [approving, setApproving] = useState<AdminAnnouncement | null>(null);
  const [deleting, setDeleting] = useState<AdminAnnouncement | null>(null);
  const { state, reload, update } = useList({
    fetchPage: () => api.GET("/admin/announcements"),
    parse: (data) => {
      const { items, reach } = AdminAnnouncementList.parse(data);
      return { items, total: items.length, reach };
    },
    what: "announcements",
  });
  const [writeReady, setWriteReady] = useState(false);
  useEffect(() => {
    if (state.kind === "ready") setWriteReady(true);
  }, [state.kind]);
  const waiting = state.kind === "ready" ? state.items.filter((item) => !item.approvedAt) : [];
  const sent = state.kind === "ready" ? state.items.filter((item) => item.approvedAt) : [];

  return (
    <section aria-labelledby="announcements-title" className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScreenTitle id="announcements-title">{t("admin.announcements.title")}</ScreenTitle>
        <RefreshButton
          onClick={() => {
            setSaid(null);
            void reload();
          }}
        >
          {t("admin.announcements.refresh")}
        </RefreshButton>
      </div>
      <p ref={status} tabIndex={-1} aria-live="polite" className="font-medium empty:sr-only">
        {said && t(`admin.announcements.${said}Now`)}
      </p>
      {state.kind === "loading" && <Loading>{t("load.loading")}</Loading>}
      {state.kind === "error" && <Alert>{t("admin.loadFailed")}</Alert>}
      {state.kind === "ready" && (
        <>
          {/* What waits first, as the front page lists it: the second admin's task, above the form. */}
          <section aria-labelledby="announcements-waiting" className="space-y-3">
            <h3 id="announcements-waiting" className="text-lg font-semibold">
              {t("admin.announcements.waiting")}
            </h3>
            {waiting.length === 0 ? (
              <p className="text-muted-foreground">{t("admin.announcements.waitingNone")}</p>
            ) : (
              <ul className="grid gap-3">
                {waiting.map((item) => (
                  <Item key={item.id} item={item}>
                    {item.yours ? (
                      <p>{t("admin.announcements.yours")}</p>
                    ) : (
                      <Button
                        onClick={() => {
                          setSaid(null);
                          setApproving(item);
                        }}
                      >
                        {t("admin.announcements.approve")}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSaid(null);
                        setDeleting(item);
                      }}
                    >
                      {t("admin.announcements.delete")}
                    </Button>
                  </Item>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      {(writeReady || state.kind === "ready") && state.kind !== "forbidden" && (
        <WriteForm
          available={state.kind === "ready"}
          draft={draft}
          setDraft={setDraft}
          onWritten={(written) => {
            setSaid("saved");
            update((items) => [written, ...items]);
          }}
          onTyping={() => setSaid(null)}
        />
      )}
      {state.kind === "ready" && (
        <>
          <section aria-labelledby="announcements-sent" className="space-y-3">
            <h3 id="announcements-sent" className="text-lg font-semibold">
              {t("admin.announcements.sent")}
            </h3>
            {sent.length === 0 ? (
              <p className="text-muted-foreground">{t("admin.announcements.sentNone")}</p>
            ) : (
              <ul className="grid gap-3">
                {sent.map((item) => (
                  <Item key={item.id} item={item} />
                ))}
              </ul>
            )}
          </section>
          {approving && (
            <ApproveStep
              item={approving}
              reach={state.reach}
              onCancel={() => setApproving(null)}
              onDone={async (approved) => {
                setApproving(null);
                setSaid("sent");
                update((items) => items.map((item) => (item.id === approved.id ? approved : item)));
              }}
            />
          )}
          {deleting && (
            <DeleteStep
              item={deleting}
              onCancel={() => setDeleting(null)}
              onDone={async () => {
                setDeleting(null);
                setSaid("deleted");
                update((items) => items.filter((item) => item.id !== deleting.id));
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

/** The form: a title and a body in each language, Swedish optional, saved as a draft that waits for a second admin. */
function WriteForm({
  available,
  draft,
  setDraft,
  onWritten,
  onTyping,
}: {
  available: boolean;
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
  onWritten: (written: AdminAnnouncement) => void;
  onTyping: () => void;
}) {
  const { t } = useT();
  const ids = useId();
  const [problem, setProblem] = useState<Problem | null>(null);
  const submitted = useRef<Draft | null>(null);
  const { sending, refused, send } = useSend({
    answer: AdminAnnouncement,
    refusals: WRITE_REFUSALS,
    onShell: () => undefined,
    onDone: async (written) => {
      setDraft((current) => (current === submitted.current ? EMPTY : current));
      onWritten(written);
    },
  });

  const change = (language: Language, part: keyof Words, value: string) => {
    onTyping();
    setProblem(null);
    setDraft((before) => ({ ...before, [language]: { ...before[language], [part]: value } }));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!available) return;
    const body = draftOf(draft);
    if (typeof body === "string") return setProblem(body);
    void send(() => {
      submitted.current = draft;
      return api.POST("/admin/announcements", { body });
    });
  };

  return (
    <section aria-labelledby="announcements-write" className="space-y-3">
      <h3 id="announcements-write" className="text-[min(1.125rem,8vw)] font-semibold">
        {t("admin.announcements.write")}
      </h3>
      <form className="grid max-w-2xl gap-6" onSubmit={submit} noValidate>
        {LANGUAGES.map((language) => (
          <fieldset key={language} className="grid gap-3">
            <legend className="mb-1 font-medium">
              {t(
                language === "sv"
                  ? "admin.announcements.swedishOptional"
                  : LANGUAGE_NAMES[language],
              )}
            </legend>
            {language === "sv" && (
              <p className="text-sm text-muted-foreground">
                {t("admin.announcements.swedishFallback")}
              </p>
            )}
            <div className="grid gap-2">
              <Label htmlFor={`${ids}-${language}-title`}>
                {t("admin.announcements.titleField")}
              </Label>
              <Input
                id={`${ids}-${language}-title`}
                maxLength={ANNOUNCEMENT_TITLE_MAX}
                required={language !== "sv"}
                value={draft[language].title}
                onChange={(event) => change(language, "title", event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${ids}-${language}-body`}>
                {t("admin.announcements.bodyField")}
              </Label>
              <Textarea
                id={`${ids}-${language}-body`}
                maxLength={ANNOUNCEMENT_BODY_MAX}
                required={language !== "sv"}
                rows={4}
                value={draft[language].body}
                onChange={(event) => change(language, "body", event.target.value)}
              />
            </div>
          </fieldset>
        ))}
        {problem && <Alert>{t(`admin.announcements.${problem}`)}</Alert>}
        {refused && <Alert>{t(refused)}</Alert>}
        <div>
          <Button
            type="submit"
            aria-disabled={!available || undefined}
            aria-busy={sending || undefined}
          >
            {t("admin.announcements.save")}
          </Button>
        </div>
      </form>
    </section>
  );
}

/** One announcement: when, and its words in each language, Swedish's absence said in words. */
function Item({ item, children }: { item: AdminAnnouncement; children?: ReactNode }) {
  const { t, locale } = useT();
  const at = formatDateTime(locale, new Date(item.approvedAt ?? item.writtenAt));
  return (
    <li>
      <Card className="py-0 sm:py-0">
        <CardContent className="gap-4 py-4">
          <p className="text-sm text-muted-foreground">
            {t(item.approvedAt ? "admin.announcements.sentAt" : "admin.announcements.writtenAt", {
              at,
            })}
          </p>
          <dl className="grid gap-3">
            {LANGUAGES.map((language) => {
              const words = item[language];
              return (
                <div key={language} className="grid gap-1">
                  <dt className="text-sm font-medium">{t(LANGUAGE_NAMES[language])}</dt>
                  {words ? (
                    <dd className="grid gap-1">
                      <p className="font-semibold wrap-anywhere">{words.title}</p>
                      <p className="whitespace-pre-line wrap-anywhere">{words.body}</p>
                    </dd>
                  ) : (
                    <dd className="text-muted-foreground">{t("admin.announcements.noSwedish")}</dd>
                  )}
                </div>
              );
            })}
          </dl>
          {children && <div className="flex flex-wrap items-center gap-3">{children}</div>}
        </CardContent>
      </Card>
    </li>
  );
}

/** The second admin's confirm step: what sending does, to how many, before it is sent. */
function ApproveStep({
  item,
  reach,
  onCancel,
  onDone,
}: {
  item: AdminAnnouncement;
  reach: AnnouncementReach;
  onCancel: () => void;
  onDone: (approved: AdminAnnouncement) => Promise<void>;
}) {
  const { t } = useT();
  // A 403 is the shell's to say (#302): the step closes with no words of its own.
  const { sending, refused, send, cancel } = useSend({
    answer: AdminAnnouncement,
    refusals: APPROVE_REFUSALS,
    onShell: onCancel,
    onCancel,
    onDone,
  });
  return (
    <Dialog
      title={t("admin.announcements.confirmSend.title")}
      onClose={cancel}
      initialFocus="dialog"
    >
      <div className="grid gap-4">
        <p className="font-medium wrap-anywhere">{item.en.title}</p>
        <p>{t("admin.announcements.confirmSend.effect", reach)}</p>
        {refused && <Alert>{t(refused)}</Alert>}
        <div className="flex flex-wrap gap-3">
          <Button
            aria-busy={sending || undefined}
            onClick={() =>
              void send(() =>
                api.POST("/admin/announcements/{id}/approve", {
                  params: { path: { id: item.id } },
                }),
              )
            }
          >
            {t("admin.announcements.confirmSend.apply")}
          </Button>
          <Button variant="outline" aria-disabled={sending || undefined} onClick={cancel}>
            {t("admin.announcements.cancel")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** A draft's deletion, said in words before it is done. */
function DeleteStep({
  item,
  onCancel,
  onDone,
}: {
  item: AdminAnnouncement;
  onCancel: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useT();
  const { sending, refused, send, cancel } = useSend({
    answer: Deleted,
    refusals: DELETE_REFUSALS,
    onShell: onCancel,
    onCancel,
    onDone,
  });
  return (
    <Dialog title={t("admin.announcements.confirmDelete.title")} onClose={cancel}>
      <div className="grid gap-4">
        <p className="font-medium wrap-anywhere">{item.en.title}</p>
        <p>{t("admin.announcements.confirmDelete.effect")}</p>
        {refused && <Alert>{t(refused)}</Alert>}
        <div className="flex flex-wrap gap-3">
          <Button
            variant="destructive"
            aria-busy={sending || undefined}
            onClick={() =>
              void send(async () => {
                const answer = await api.DELETE("/admin/announcements/{id}", {
                  params: { path: { id: item.id } },
                });
                return answer.response.status === 204
                  ? { ...answer, data: { deleted: true } }
                  : answer;
              })
            }
          >
            {t("admin.announcements.confirmDelete.apply")}
          </Button>
          <Button variant="outline" aria-disabled={sending || undefined} onClick={cancel}>
            {t("admin.announcements.cancel")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
