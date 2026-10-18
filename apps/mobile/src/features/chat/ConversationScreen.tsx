import type { PlainMessageKey } from "@kuutti/i18n";
import {
  type ChatMessage,
  type ConversationDetail,
  MESSAGES_PAGE_DEFAULT,
  messageLength,
} from "@kuutti/schema";
import { Image } from "expo-image";
import { useFocusEffect, useRouter } from "expo-router";
import ImagePlus from "lucide-react-native/icons/image-plus";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { AppState, KeyboardAvoidingView, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { type PickedPhoto, pickPrepared } from "@/features/media";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/locale";
import { DECORATIVE } from "@/theme/a11y";
import { useHapticTap } from "@/theme/haptics";
import { TextBubble } from "./Bubble";
import { ConnectionLine } from "./ConnectionLine";
import { counterpartName } from "./ConversationsScreen";
import { fetchConversation, fetchMessages, markRead, sendMessage, sendPhoto } from "./client";
import { PhotoBubble, SendingPhotoBubble } from "./PhotoBubble";
import { type ConversationLive, merged, useChatLive } from "./store";
import { dayOf } from "./time";

type Loaded = { detail: ConversationDetail; messages: ChatMessage[] };
type ScreenView =
  | { status: "loading" }
  | ({ status: "ready" } & Loaded)
  | { status: "gone" }
  | { status: "failed"; error: unknown };

/**
 * The refusals the composer says in its own words; anything else is a failure
 * to try again. A Map, so a code like `toString` finds nothing rather than a
 * prototype member. A photo's (#350) are the check's, the day's photos, the
 * file's and the pipeline's, in the words the photos screen has for the last two.
 */
const REFUSALS: ReadonlyMap<string, PlainMessageKey> = new Map([
  ["message_too_long", "chat.composer.error.message_too_long"],
  ["contact_details", "chat.composer.error.contact_details"],
  ["conversation_closed", "chat.composer.error.conversation_closed"],
  ["message_budget_exceeded", "chat.composer.error.message_budget_exceeded"],
  ["photo_rejected_nudity", "errors.photo_rejected_nudity"],
  ["photo_rejected_violence", "errors.photo_rejected_violence"],
  ["photo_rejected_other", "errors.photo_rejected_other"],
  ["message_photo_budget_exceeded", "errors.message_photo_budget_exceeded"],
  ["photo_unsupported", "photos.error.photo_unsupported"],
  ["photo_invalid", "photos.error.photo_invalid"],
  ["photo_too_many_pixels", "photos.error.tooLarge"],
  ["payload_too_large", "photos.error.tooLarge"],
  ["media_busy", "photos.error.media_busy"],
  ["media_unavailable", "photos.error.media_unavailable"],
]);

/**
 * The refusals of the words or of the pace, not of the picture: the photo
 * stays attached for the next try, as the words stay in the field. Any other
 * refusal of a photo takes it off.
 */
const KEEPS_PHOTO: ReadonlySet<string> = new Set([
  "message_too_long",
  "contact_details",
  "message_budget_exceeded",
  "media_busy",
]);

/** A message on its way: shown until the API's answer or the socket brings one with its id. */
type Pending = { body: string; at: string; clientId: string; photo: PickedPhoto | null };

/** The detail as the socket has told it since it was read (#349): the state, and the read mark. */
function withLive(
  detail: ConversationDetail,
  live: ConversationLive | undefined,
): ConversationDetail {
  if (!live) return detail;
  const { state } = live;
  return {
    ...detail,
    ...(state && state.state !== "gone" ? { state: state.state, closedHow: state.closedHow } : {}),
    counterpartReadUpTo: Math.max(detail.counterpartReadUpTo, live.readUpTo),
  };
}

/**
 * One conversation (#348): the counterpart in the header, the messages oldest
 * at the top and newest at the bottom, a day line where the day changes, the
 * person's own on the right and the other's on the left, each with its time
 * and read by a screen reader as who, when and what; "Read" under the last
 * own message the other has read. The composer counts down from the longest
 * message, sends with Send (44 points, labelled, off while empty), shows the
 * message at once and swaps it for the API's answer; a refusal or a failure
 * is said under it in words, the words kept in the field, and the same words
 * sent again keep their id, so a send whose answer was lost is not doubled.
 * An archived conversation says that writing brings it back; a closed one
 * says how it ended instead of the composer. Read again on focus, and marked
 * read up to the newest message while on the screen. No gesture: earlier
 * messages are a button. Live (#349): what the socket brings joins what was
 * read, by sequence; the read mark and the state follow its frames; "Online"
 * under the header while the counterpart is; a line at the top while the
 * connection is lost. A photo (#350): Add photo beside the field picks one
 * through the photos screen's chain, shown above the field until it is sent or
 * removed; Send then sends it with the field's words as its caption, its
 * progress in the sending row. A refusal of the picture takes it off; a
 * failure keeps it and its id for the next try. A photo that came without
 * URLs (the socket's) or whose URL expired is read again over HTTP, once.
 */
export function ConversationScreen({ id }: { id: string }) {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const [view, setView] = useState<ScreenView>({ status: "loading" });
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [percent, setPercent] = useState(0);
  const [attached, setAttached] = useState<PickedPhoto | null>(null);
  const [picking, setPicking] = useState(false);
  const [refusal, setRefusal] = useState<PlainMessageKey | null>(null);
  const scroll = useRef<ScrollView>(null);
  const loaded = useRef<ChatMessage[]>([]);
  const marked = useRef(0);
  // Whether a page back may hold more: the last one came full. Not the first
  // sequence: a message the caller may not read still has its place.
  const [more, setMore] = useState(false);
  const unsent = useRef<{ body: string; clientId: string; photo: PickedPhoto | null } | null>(null);
  // Only a screen in front marks read: one under another screen, or under
  // the app switcher or the control centre (iOS's inactive), is not being read.
  const focused = useRef(false);
  const inFront = () =>
    focused.current &&
    AppState.currentState !== "background" &&
    AppState.currentState !== "inactive";
  const live = useChatLive();
  const here = live.conversations[id];
  const arrived = here?.messages;
  const { report } = live;

  const show = useCallback(
    (detail: ConversationDetail, messages: ChatMessage[]) => {
      loaded.current = messages;
      setView({ status: "ready", detail, messages });
      // A send whose answer was lost and whose words came back with a
      // refusal: the message arrived after all, so it was sent.
      const lost = unsent.current;
      if (lost && messages.some((m) => m.clientId === lost.clientId)) {
        unsent.current = null;
        setRefusal(null);
        setText((words) => (words === lost.body ? "" : words));
        setAttached((photo) => (photo === lost.photo ? null : photo));
      }
      // The newest is on the screen now: read up to it, once per new message of theirs.
      const newest = messages.at(-1);
      if (
        inFront() &&
        newest &&
        newest.seq > marked.current &&
        messages.some((m) => m.side === "theirs")
      ) {
        marked.current = newest.seq;
        markRead(id, newest.seq).catch(() => {
          marked.current = 0;
        });
      }
    },
    [id],
  );

  const load = useCallback(async () => {
    try {
      const detail = await fetchConversation(id);
      const newest = loaded.current.at(-1);
      // What is held is taken once the page is here, not before: what came
      // meanwhile (the socket's, a photo's URLs read again) is kept.
      if (newest) {
        const page = await fetchMessages(id, { after: newest.seq, limit: 100 });
        show(detail, merged(loaded.current, page));
      } else {
        const page = await fetchMessages(id, {});
        setMore(page.length === MESSAGES_PAGE_DEFAULT);
        show(detail, merged(loaded.current, page.reverse()));
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) setView({ status: "gone" });
      else if (loaded.current.length === 0) setView({ status: "failed", error });
    }
  }, [id, show]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void load();
      return () => {
        focused.current = false;
      };
    }, [load]),
  );

  // Back from the app switcher or the control centre: what came meanwhile is read now.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active" && focused.current) void load();
    });
    return () => subscription.remove();
  }, [load]);

  // What the socket brought joins what is shown, and is marked read while in
  // front; only from the oldest shown on, so a message held from long before
  // the page leaves no gap that Earlier messages would step over.
  const shownDetail = view.status === "ready" ? view.detail : null;
  useEffect(() => {
    if (!shownDetail || !arrived) return;
    const oldest = loaded.current[0]?.seq ?? 0;
    show(
      shownDetail,
      merged(
        loaded.current,
        arrived.filter((m) => m.seq >= oldest),
      ),
    );
  }, [shownDetail, arrived, show]);

  // The newest held is what the socket's next resume names.
  const newestSeq = view.status === "ready" ? (view.messages.at(-1)?.seq ?? 0) : null;
  useEffect(() => {
    if (newestSeq !== null) report({ [id]: newestSeq });
  }, [id, newestSeq, report]);

  // A photo without URLs (the socket's copy, rules/api.md) or with an expired
  // URL: the message read again over HTTP signs them, and the
  // copy with them takes its place. Once each for a message and a reason; a
  // read that fails may be tried again.
  const reread = useRef(new Set<string>());
  const readAgain = useCallback(
    async (message: ChatMessage, why: "missing" | "expired") => {
      const key = `${why} ${message.id}`;
      if (reread.current.has(key)) return;
      reread.current.add(key);
      try {
        const [fresh] = await fetchMessages(id, { after: message.seq - 1, limit: 1 });
        if (fresh?.id !== message.id) return;
        loaded.current = merged(loaded.current, [fresh]);
        setView((was) => (was.status === "ready" ? { ...was, messages: loaded.current } : was));
      } catch {
        reread.current.delete(key);
      }
    },
    [id],
  );
  const shownMessages = view.status === "ready" ? view.messages : null;
  const sendingId = pending?.clientId ?? null;
  useEffect(() => {
    for (const message of shownMessages ?? []) {
      // One's own photo on its way: the send's answer brings it signed.
      const answering = sendingId !== null && message.clientId === sendingId;
      if (message.photo && !message.photo.urls && !answering) void readAgain(message, "missing");
    }
  }, [shownMessages, sendingId, readAgain]);

  const earlier = async (detail: ConversationDetail, oldest: number) => {
    tap();
    try {
      const page = await fetchMessages(id, { before: oldest });
      setMore(page.length === MESSAGES_PAGE_DEFAULT);
      show(detail, merged(page, loaded.current));
    } catch {
      setRefusal("chat.conversation.failed");
    }
  };

  const attach = async () => {
    tap();
    setRefusal(null);
    setPicking(true);
    try {
      const picked = await pickPrepared();
      if (picked.kind === "picked") setAttached(picked.photo);
      else if (picked.kind === "denied") setRefusal("photos.error.permission");
      else if (picked.kind === "refused_local") setRefusal("photos.refused.local");
    } catch {
      // The phone could not read the picture to resize it.
      setRefusal("photos.error.photo_invalid");
    } finally {
      setPicking(false);
    }
  };

  const send = async (detail: ConversationDetail) => {
    const body = text.trim();
    const photo = attached;
    tap();
    // The same words, and the same picture, sent again keep their id.
    const again = unsent.current;
    const clientId =
      again && again.body === body && again.photo?.uri === photo?.uri
        ? again.clientId
        : globalThis.expo.uuidv4();
    unsent.current = { body, clientId, photo };
    setPending({ body, at: new Date().toISOString(), clientId, photo });
    setPercent(0);
    setText("");
    setAttached(null);
    setRefusal(null);
    try {
      const message = photo
        ? await sendPhoto(id, { photo, clientId, caption: body }, (fraction) =>
            setPercent(Math.round(fraction * 100)),
          )
        : await sendMessage(id, { clientId, body });
      unsent.current = null;
      setPending(null);
      // A message brings an archived conversation back (TD-13).
      show({ ...detail, state: "open" }, merged(loaded.current, [message]));
    } catch (error) {
      setPending(null);
      // The socket brought it already: the answer was lost, not the message.
      if (loaded.current.some((m) => m.clientId === clientId)) {
        unsent.current = null;
        return;
      }
      setText(body);
      const code = (error instanceof ApiError ? error.code : undefined) ?? "";
      const refused = REFUSALS.get(code);
      setRefusal(refused ?? "chat.composer.error.failed");
      if (photo && (!refused || KEEPS_PHOTO.has(code))) setAttached(photo);
      // A refusal is final for these words; only a failure is tried again with the same id.
      if (refused) unsent.current = null;
      if (code === "conversation_closed") void load();
    }
  };

  // The one who blocked sees it gone at once (ADR-031 §4).
  const shown: ScreenView = here?.state?.state === "gone" ? { status: "gone" } : view;
  const messages = shown.status === "ready" ? shown.messages : [];
  const detail = shown.status === "ready" ? withLive(shown.detail, here) : null;
  const sending =
    pending && !messages.some((m) => m.clientId === pending.clientId) ? pending : null;
  const title = detail ? counterpartName(t, detail) : t("chat.list.title");
  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader title={title} backLabel={t("chat.back")} onBack={() => router.back()} />
      <ConnectionLine />
      {detail && detail.state !== "closed" && live.status === "open" && here?.online && (
        <View className="flex-row items-center gap-2 px-6 pt-2">
          <View className="h-2.5 w-2.5 rounded-full bg-primary" {...DECORATIVE} />
          <Text variant="muted">{t("chat.presence.online")}</Text>
        </View>
      )}
      {shown.status === "loading" && (
        <Text accessibilityLiveRegion="polite" className="p-6">
          {t("chat.conversation.loading")}
        </Text>
      )}
      {shown.status === "gone" && (
        <Text accessibilityLiveRegion="polite" className="p-6">
          {t("chat.conversation.gone")}
        </Text>
      )}
      {shown.status === "failed" && (
        <View className="p-6">
          <LoadFailed
            headline={t("chat.conversation.failed")}
            error={shown.error}
            onRetry={() => {
              setView({ status: "loading" });
              void load();
            }}
          />
        </View>
      )}
      {detail && (
        // Padding on Android too: the app draws edge to edge, so the window
        // no longer resizes for the keyboard, which then covered the composer.
        <KeyboardAvoidingView className="flex-1" behavior="padding">
          <Conversation
            detail={detail}
            messages={messages}
            pending={sending}
            percent={percent}
            more={more}
            scroll={scroll}
            onEarlier={(oldest) => void earlier(detail, oldest)}
            onExpired={(message) => void readAgain(message, "expired")}
          />
          <View className="gap-2 border-t border-border p-4">
            {refusal && <Text accessibilityLiveRegion="assertive">{t(refusal)}</Text>}
            {detail.state === "closed" ? (
              <Text accessibilityLiveRegion="polite">
                {detail.closedHow === "erasure" ? t("chat.state.deleted") : t("chat.state.ended")}
              </Text>
            ) : (
              <Composer
                text={text}
                maxLength={detail.limits.maxLength}
                archived={detail.state === "archived"}
                sending={pending !== null}
                picking={picking}
                attached={attached}
                onChange={(value) => {
                  setText(value);
                  setRefusal(null);
                }}
                onAttach={() => void attach()}
                onDetach={() => {
                  tap();
                  setAttached(null);
                }}
                onSend={() => void send(detail)}
              />
            )}
          </View>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

function Conversation({
  detail,
  messages,
  pending,
  percent,
  more,
  scroll,
  onEarlier,
  onExpired,
}: {
  detail: ConversationDetail;
  messages: ChatMessage[];
  pending: Pending | null;
  percent: number;
  more: boolean;
  scroll: React.RefObject<ScrollView | null>;
  onEarlier: (oldest: number) => void;
  onExpired: (message: ChatMessage) => void;
}) {
  const { t, locale } = useT();
  const theirName = detail.counterpart.deleted ? t("chat.deletedUser") : detail.counterpart.name;
  const readSeq = messages
    .filter((m) => m.side === "mine" && m.seq <= detail.counterpartReadUpTo)
    .reduce((top, m) => Math.max(top, m.seq), 0);
  const first = messages[0];
  return (
    <ScrollView
      ref={scroll}
      testID="messages"
      className="flex-1"
      contentContainerClassName="gap-3 p-4"
      keyboardShouldPersistTaps="handled"
      onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
    >
      {more && first && (
        <Button variant="ghost" onPress={() => onEarlier(first.seq)}>
          {t("chat.history.earlier")}
        </Button>
      )}
      {messages.map((message, i) => (
        <Fragment key={message.id}>
          {dayOf(locale, message.createdAt) !==
            dayOf(locale, messages[i - 1]?.createdAt ?? new Date(0)) && (
            <Text variant="muted" className="self-center">
              {dayOf(locale, message.createdAt)}
            </Text>
          )}
          {message.kind === "photo" ? (
            <PhotoBubble
              message={message}
              conversationId={detail.id}
              who={message.side === "mine" ? t("chat.message.you") : theirName}
              note={message.seq === readSeq ? t("chat.message.read") : null}
              onExpired={onExpired}
            />
          ) : (
            <TextBubble
              mine={message.side === "mine"}
              who={message.side === "mine" ? t("chat.message.you") : theirName}
              body={message.body ?? ""}
              at={message.createdAt}
              note={message.seq === readSeq ? t("chat.message.read") : null}
            />
          )}
        </Fragment>
      ))}
      {pending?.photo && (
        <SendingPhotoBubble
          who={t("chat.message.you")}
          uri={pending.photo.uri}
          caption={pending.body}
          at={pending.at}
          percent={percent}
        />
      )}
      {pending && !pending.photo && (
        <TextBubble
          mine
          who={t("chat.message.you")}
          body={pending.body}
          at={pending.at}
          note={t("chat.message.sending")}
        />
      )}
    </ScrollView>
  );
}

/** The attached photo's edge above the field, in points. */
const ATTACHED_EDGE = 56;

function Composer({
  text,
  maxLength,
  archived,
  sending,
  picking,
  attached,
  onChange,
  onAttach,
  onDetach,
  onSend,
}: {
  text: string;
  maxLength: number;
  archived: boolean;
  sending: boolean;
  picking: boolean;
  attached: PickedPhoto | null;
  onChange: (value: string) => void;
  onAttach: () => void;
  onDetach: () => void;
  onSend: () => void;
}) {
  const { t } = useT();
  const left = maxLength - messageLength(text.trim());
  // A photo goes without words; words go without a photo.
  const empty = text.trim().length === 0 && attached === null;
  return (
    <>
      {archived && <Text>{t("chat.archived.banner")}</Text>}
      {attached && (
        <View className="flex-row items-center gap-3">
          <Image
            testID="photo-attached"
            source={{ uri: attached.uri }}
            contentFit="cover"
            style={{ width: ATTACHED_EDGE, height: ATTACHED_EDGE, borderRadius: 8 }}
            {...DECORATIVE}
          />
          <Text accessibilityLiveRegion="polite" className="flex-1">
            {t("chat.composer.photoAttached")}
          </Text>
          <Button variant="ghost" disabled={sending} onPress={onDetach}>
            {t("chat.composer.removePhoto")}
          </Button>
        </View>
      )}
      <View className="flex-row items-end gap-2">
        <Button
          variant="ghost"
          size="icon"
          accessibilityLabel={t("chat.composer.photo")}
          disabled={sending || picking}
          onPress={onAttach}
        >
          <Icon as={ImagePlus} />
        </Button>
        <Input
          accessibilityLabel={t("chat.composer.label")}
          placeholder={t("chat.composer.placeholder")}
          value={text}
          multiline
          textAlignVertical="top"
          className="min-h-touch w-auto flex-1"
          onChangeText={onChange}
        />
      </View>
      <View className="flex-row items-center justify-between gap-3">
        <Text variant="muted" className="flex-1">
          {left < 0
            ? t("chat.composer.error.message_too_long")
            : t("chat.composer.remaining", { characters: left })}
        </Text>
        <Button disabled={empty || left < 0 || sending} onPress={onSend}>
          {t("chat.composer.send")}
        </Button>
      </View>
    </>
  );
}
