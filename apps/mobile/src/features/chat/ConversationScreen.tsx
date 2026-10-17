import type { PlainMessageKey } from "@kuutti/i18n";
import {
  type ChatMessage,
  type ConversationDetail,
  MESSAGES_PAGE_DEFAULT,
  messageLength,
} from "@kuutti/schema";
import { useFocusEffect, useRouter } from "expo-router";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/locale";
import { cn } from "@/lib/utils";
import { DECORATIVE } from "@/theme/a11y";
import { useHapticTap } from "@/theme/haptics";
import { ConnectionLine } from "./ConnectionLine";
import { counterpartName } from "./ConversationsScreen";
import { fetchConversation, fetchMessages, markRead, sendMessage } from "./client";
import { type ConversationLive, merged, useChatLive } from "./store";
import { dayOf, timeOf } from "./time";

type Loaded = { detail: ConversationDetail; messages: ChatMessage[] };
type ScreenView =
  | { status: "loading" }
  | ({ status: "ready" } & Loaded)
  | { status: "gone" }
  | { status: "failed"; error: unknown };

/** The refusals the composer says in its own words; anything else is a failure to try again. */
const REFUSALS: Record<string, PlainMessageKey> = {
  message_too_long: "chat.composer.error.message_too_long",
  contact_details: "chat.composer.error.contact_details",
  conversation_closed: "chat.composer.error.conversation_closed",
  message_budget_exceeded: "chat.composer.error.message_budget_exceeded",
};

/** A message on its way: shown until the API's answer or the socket brings one with its id. */
type Pending = { body: string; at: string; clientId: string };

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
 * connection is lost.
 */
export function ConversationScreen({ id }: { id: string }) {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const [view, setView] = useState<ScreenView>({ status: "loading" });
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [refusal, setRefusal] = useState<PlainMessageKey | null>(null);
  const scroll = useRef<ScrollView>(null);
  const loaded = useRef<ChatMessage[]>([]);
  const marked = useRef(0);
  // Whether a page back may hold more: the last one came full. Not the first
  // sequence: a message the caller may not read still has its place.
  const [more, setMore] = useState(false);
  const unsent = useRef<{ body: string; clientId: string } | null>(null);
  // Only a screen in front marks read: one under another screen is not being read.
  const focused = useRef(false);
  const live = useChatLive();
  const here = live.conversations[id];
  const arrived = here?.messages;
  const { report } = live;

  const show = useCallback(
    (detail: ConversationDetail, messages: ChatMessage[]) => {
      loaded.current = messages;
      setView({ status: "ready", detail, messages });
      // The newest is on the screen now: read up to it, once per new message of theirs.
      const newest = messages.at(-1);
      if (
        focused.current &&
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
      if (newest) {
        show(
          detail,
          merged(loaded.current, await fetchMessages(id, { after: newest.seq, limit: 100 })),
        );
      } else {
        const page = await fetchMessages(id, {});
        setMore(page.length === MESSAGES_PAGE_DEFAULT);
        show(detail, page.reverse());
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

  // What the socket brought joins what is shown, and is marked read while in front.
  const shownDetail = view.status === "ready" ? view.detail : null;
  useEffect(() => {
    if (shownDetail && arrived) show(shownDetail, merged(loaded.current, arrived));
  }, [shownDetail, arrived, show]);

  // The newest held is what the socket's next resume names.
  const newestSeq = view.status === "ready" ? (view.messages.at(-1)?.seq ?? 0) : null;
  useEffect(() => {
    if (newestSeq !== null) report({ [id]: newestSeq });
  }, [id, newestSeq, report]);

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

  const send = async (detail: ConversationDetail) => {
    const body = text.trim();
    tap();
    const clientId =
      unsent.current?.body === body ? unsent.current.clientId : globalThis.expo.uuidv4();
    unsent.current = { body, clientId };
    setPending({ body, at: new Date().toISOString(), clientId });
    setText("");
    setRefusal(null);
    try {
      const message = await sendMessage(id, { clientId, body });
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
      const code = error instanceof ApiError ? error.code : undefined;
      setRefusal((code && REFUSALS[code]) || "chat.composer.error.failed");
      // A refusal is final for these words; only a failure is tried again with the same id.
      if (code && REFUSALS[code]) unsent.current = null;
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
            more={more}
            scroll={scroll}
            onEarlier={(oldest) => void earlier(detail, oldest)}
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
                onChange={(value) => {
                  setText(value);
                  setRefusal(null);
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
  more,
  scroll,
  onEarlier,
}: {
  detail: ConversationDetail;
  messages: ChatMessage[];
  pending: Pending | null;
  more: boolean;
  scroll: React.RefObject<ScrollView | null>;
  onEarlier: (oldest: number) => void;
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
          <Bubble
            mine={message.side === "mine"}
            who={message.side === "mine" ? t("chat.message.you") : theirName}
            body={message.body ?? ""}
            at={message.createdAt}
            note={message.seq === readSeq ? t("chat.message.read") : null}
          />
        </Fragment>
      ))}
      {pending && (
        <Bubble
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

/** One message: the person's own on the right, the other's on the left, read as who, when and what. */
function Bubble({
  mine,
  who,
  body,
  at,
  note,
}: {
  mine: boolean;
  who: string;
  body: string;
  at: string;
  note: string | null;
}) {
  const { t, locale } = useT();
  const time = timeOf(locale, at);
  return (
    <View
      className={cn("max-w-[85%] gap-1", mine ? "items-end self-end" : "items-start self-start")}
    >
      <View
        accessible
        accessibilityLabel={t("chat.message.label", { who, time, text: body })}
        className={cn("rounded-2xl px-3 py-2", mine ? "bg-primary" : "bg-secondary")}
      >
        <Text className={mine ? "text-primary-foreground" : "text-secondary-foreground"}>
          {body}
        </Text>
      </View>
      <Text variant="muted" {...DECORATIVE}>
        {time}
      </Text>
      {note && <Text variant="muted">{note}</Text>}
    </View>
  );
}

function Composer({
  text,
  maxLength,
  archived,
  sending,
  onChange,
  onSend,
}: {
  text: string;
  maxLength: number;
  archived: boolean;
  sending: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
}) {
  const { t } = useT();
  const left = maxLength - messageLength(text.trim());
  return (
    <>
      {archived && <Text>{t("chat.archived.banner")}</Text>}
      <Input
        accessibilityLabel={t("chat.composer.label")}
        placeholder={t("chat.composer.placeholder")}
        value={text}
        multiline
        textAlignVertical="top"
        className="min-h-touch"
        onChangeText={onChange}
      />
      <View className="flex-row items-center justify-between gap-3">
        <Text variant="muted" className="flex-1">
          {left < 0
            ? t("chat.composer.error.message_too_long")
            : t("chat.composer.remaining", { characters: left })}
        </Text>
        <Button disabled={text.trim().length === 0 || left < 0 || sending} onPress={onSend}>
          {t("chat.composer.send")}
        </Button>
      </View>
    </>
  );
}
