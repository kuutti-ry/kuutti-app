import { realLocale } from "@kuutti/i18n";
import {
  CONTACT_INPUT_MAX,
  CONTACT_KINDS,
  type ContactKind,
  normaliseContact,
} from "@kuutti/schema";
import ChevronDown from "lucide-react-native/icons/chevron-down";
import CircleAlert from "lucide-react-native/icons/circle-alert";
import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, Platform, type TextInput, View } from "react-native";
import { LoadFailed } from "@/components/LoadFailed";
import { Notice as Said } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/locale";
import { useRowData } from "@/lib/row-data";
import { useReportUnsaved } from "@/lib/unsaved";
import { cn } from "@/lib/utils";
import { useHapticTap, useHapticWarning } from "@/theme/haptics";
import { ContactMark } from "./ContactMark";
import { CountryPicker } from "./CountryPicker";
import { fetchContacts, removeContact, saveContact } from "./client";
import { codeOf, HOME_REGION, type Region, readPhone, showPhone } from "./phone";

type Stored = Partial<Record<ContactKind, string | undefined>>;
type Notice =
  | "saved"
  | "removed"
  | "stillSaved"
  | "invalid"
  | "phoneShort"
  | "phoneLong"
  | "phoneInvalid"
  | "pace"
  | "failed";
/** The answers that leave the words not kept. */
const REFUSED: ReadonlySet<Notice> = new Set([
  "invalid",
  "phoneShort",
  "phoneLong",
  "phoneInvalid",
  "pace",
  "failed",
]);
const PHONE_REFUSAL = { short: "phoneShort", long: "phoneLong", invalid: "phoneInvalid" } as const;

/** A number is typed as one, on the phone's number pad; neither is capitalised or corrected. */
const NUMBER: ReadonlySet<ContactKind> = new Set(["phone", "whatsapp"]);

/**
 * The person's contacts (#103), under Settings' Ways to reach you row (#511):
 * the line that nobody sees them until one is shared in a conversation, then
 * a part per kind (phone number, WhatsApp, Telegram, Instagram, Snapchat),
 * with a hairline between them rather than cards inside the list's card.
 * While they are being read it says so; a read that failed says why, with a
 * way to read them again. The kinds kept go to `onStored`, for the row.
 */
export function YourContacts({ onStored }: { onStored?: (kept: readonly ContactKind[]) => void }) {
  const { t } = useT();
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [error, setError] = useState<unknown>(null);
  const [stored, setStored] = useState<Stored>({});

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const read = useCallback(() => {
    setState("loading");
    fetchContacts().then(
      (contacts) => {
        if (!mounted.current) return;
        setStored(Object.fromEntries(contacts.map(({ kind, value }) => [kind, value])));
        setState("ready");
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setError(failure);
        setState("unavailable");
      },
    );
  }, []);
  useEffect(read, [read]);
  useEffect(() => {
    if (state === "ready") onStored?.(CONTACT_KINDS.filter((kind) => stored[kind]));
  }, [state, stored, onStored]);

  if (state === "loading") {
    return (
      <Text variant="muted" accessibilityLiveRegion="polite">
        {t("settings.contacts.loading")}
      </Text>
    );
  }
  if (state === "unavailable") {
    return <LoadFailed headline={t("settings.contacts.loadFailed")} error={error} onRetry={read} />;
  }
  return (
    <View className="gap-6">
      <Text>{t("settings.contacts.intro")}</Text>
      {CONTACT_KINDS.map((kind, index) => (
        <View key={kind} className={cn(index > 0 && "border-t border-border pt-6")}>
          <ContactCard
            kind={kind}
            stored={stored[kind] ?? null}
            onStored={(value) => setStored((was) => ({ ...was, [kind]: value ?? undefined }))}
          />
        </View>
      ))}
    </View>
  );
}

/**
 * One kind, as the e-mail's (#148): its mark (#474), its name and Remove
 * beside it (only while one is kept), what to type, and the field with what
 * is kept in its stored form. There is no Save: leaving the field keeps what
 * it holds, as the profile does (the maintainer, 29/10/2026, #511). What is
 * typed is checked on the phone first, with the API's own rule; a refusal
 * is said under the field and heard as its hint, the words stay, and once
 * said it is checked again as the person types, going the moment the words
 * are right. An emptied field takes nothing away: the kept one comes back,
 * and Remove is the way. A keep or a removal counts with the messages of a
 * minute (#103), and one past them, or a failure, keeps the words with a way
 * to try again. One request at a time; an answer leaves alone what was typed
 * after it was asked. Leaving Settings with a change not yet sent sends it
 * on the way out.
 */
function ContactCard({
  kind,
  stored,
  onStored,
}: {
  kind: ContactKind;
  stored: string | null;
  onStored: (value: string | null) => void;
}) {
  const { t, locale } = useT();
  const tap = useHapticTap();
  const warn = useHapticWarning();
  const field = useRef<TextInput>(null);
  const number = NUMBER.has(kind);
  /** A stored piece as its field shows it: a number without its code, which stands beside it. */
  const shown = (value: string | null): string =>
    value === null ? "" : number ? showPhone(value).rest : value;
  const [typed, setTyped] = useState(() => shown(stored));
  // A number's code: the stored one's, else Finland's, whatever the phone's own region (#511).
  const [region, setRegion] = useState<Region>(() =>
    number && stored !== null ? showPhone(stored).region : HOME_REGION,
  );
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ notice: Notice; answer: number } | null>(null);
  // Whether the person typed after the request went: its answer then leaves the field alone.
  const typedSince = useRef(false);
  // What the listeners and the leaving read, which outlive a render.
  const latest = useRef({ typed, stored, busy, onStored, region });
  latest.current = { typed, stored, busy, onStored, region };

  const notice = said?.notice ?? null;
  const say = (next: Notice) => {
    setSaid((was) => ({ notice: next, answer: (was?.answer ?? 0) + 1 }));
    if (REFUSED.has(next)) warn();
  };

  /** What the field holds as it would be kept, or why it would not be. */
  const formOf = (text: string, under: Region): string | Notice | null => {
    if (text === "") return null;
    if (!number) return normaliseContact(kind, text) ?? "invalid";
    const read = readPhone(text, under);
    return "e164" in read ? read.e164 : PHONE_REFUSAL[read.refused];
  };
  const words = typed.trim();
  const kept = formOf(words, region);
  const form = kept !== null && !REFUSED.has(kept as Notice) ? kept : null;
  const refused = notice !== null && REFUSED.has(notice);
  // Typed and not kept: words that are no contact of the kind, or a right one
  // the API did not take (a failure, the minute's messages). A right one not
  // sent yet goes on the way out, and needs no word.
  useReportUnsaved(kind, words !== "" && (form === null || (form !== stored && refused)));

  const run = async (call: () => Promise<string | null>, done: "saved" | "removed") => {
    setBusy(true);
    typedSince.current = false;
    try {
      const value = await call();
      latest.current.onStored(value);
      if (!typedSince.current) setTyped(shown(value));
      if (number && value !== null) setRegion(showPhone(value).region);
      say(done);
    } catch (error) {
      const failure = error instanceof ApiError ? error : null;
      say(
        failure?.status === 400
          ? "invalid"
          : failure?.code === "message_budget_exceeded"
            ? "pace"
            : "failed",
      );
    } finally {
      setBusy(false);
    }
  };

  /** The field left: what it holds is kept, said as refused, or the kept one comes back. */
  const leave = () => {
    const { typed: now, stored: before, busy: sending, region: under } = latest.current;
    const text = now.trim();
    if (text === "") {
      if (before !== null) {
        setTyped(shown(before));
        say("stillSaved");
      }
      return;
    }
    const next = formOf(text, under);
    if (next === null || REFUSED.has(next as Notice)) {
      say(next as Notice);
      return;
    }
    if (next === before) {
      setTyped(shown(before));
      return;
    }
    // A number goes as E.164 (+358…), which the API's rule reads as it is.
    if (!sending) void run(async () => (await saveContact(kind, next)).value, "saved");
  };

  // Android's keyboard can go with the field still focused (its back key, a
  // tap on the row above): that is leaving the field too.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const gone = Keyboard.addListener("keyboardDidHide", () => {
      if (field.current?.isFocused()) field.current.blur();
    });
    return () => gone.remove();
  }, []);
  // Leaving Settings sends a right change not sent yet; a refused one was asked about first.
  useEffect(
    () => () => {
      const {
        typed: now,
        stored: before,
        busy: sending,
        onStored: keep,
        region: under,
      } = latest.current;
      const text = now.trim();
      if (text === "" || sending) return;
      const next = number
        ? (() => {
            const read = readPhone(text, under);
            return "e164" in read ? read.e164 : null;
          })()
        : normaliseContact(kind, text);
      if (next === null || next === before) return;
      saveContact(kind, next).then(
        (contact) => keep(contact.value),
        () => undefined,
      );
    },
    [kind, number],
  );

  const answerWords = said === null ? null : wordsOf(t, kind, said.notice, codeOf(region));
  const countryName =
    new Intl.DisplayNames([realLocale(locale)], { type: "region" }).of(region) ?? region;
  const input = (
    <Input
      ref={field}
      accessibilityLabel={t("settings.contacts.input", { kind })}
      // A refusal is heard with the field, not only where it is written.
      accessibilityHint={refused && answerWords ? answerWords : undefined}
      className={cn(number && "min-w-40 flex-1", refused && "border-destructive")}
      value={typed}
      maxLength={CONTACT_INPUT_MAX}
      inputMode={number ? "tel" : "text"}
      autoComplete={number ? "tel" : "off"}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      returnKeyType="done"
      onFocus={() => {
        // "Saved." stays until the field is taken up again.
        if (notice !== null && !REFUSED.has(notice)) setSaid(null);
      }}
      onBlur={leave}
      onChangeText={(text) => {
        typedSince.current = true;
        setTyped(text);
        // Once refused, read again as typed, and the refusal goes the moment the words are right.
        if (notice !== null && REFUSED.has(notice) && notice !== "pace" && notice !== "failed") {
          const now = formOf(text.trim(), region);
          if (now !== null && !REFUSED.has(now as Notice)) setSaid(null);
        }
      }}
    />
  );
  return (
    <View className="gap-3">
      <View className="gap-1.5">
        <View className="flex-row items-center gap-2">
          <ContactMark kind={kind} />
          <Text variant="title" className="flex-1">
            {t("settings.contacts.title", { kind })}
          </Text>
          {stored !== null && (
            <Button
              variant="ghost"
              className="px-3"
              disabled={busy}
              accessibilityLabel={t("settings.contacts.removeLabel", { kind })}
              onPress={() => {
                tap();
                void run(async () => {
                  await removeContact(kind);
                  return null;
                }, "removed");
              }}
            >
              {t("settings.contacts.remove")}
            </Button>
          )}
        </View>
        <Text variant="muted">{t("settings.contacts.hint", { kind })}</Text>
      </View>
      {number ? (
        <View className="flex-row flex-wrap gap-2">
          <Button
            variant="outline"
            className="px-3"
            accessibilityLabel={t("settings.contacts.country")}
            accessibilityValue={{
              text: t("settings.contacts.countryValue", {
                country: countryName,
                code: codeOf(region),
              }),
            }}
            accessibilityHint={t("settings.contacts.countryHint")}
            disabled={busy}
            onPress={() => {
              tap();
              setPicking(true);
            }}
          >
            <Text>{codeOf(region)}</Text>
            <Icon as={ChevronDown} className="text-muted-foreground" />
          </Button>
          {input}
        </View>
      ) : (
        input
      )}
      {number && (
        <CountryPicker
          open={picking}
          region={region}
          onClose={() => setPicking(false)}
          onChoose={(chosen) => {
            setPicking(false);
            setRegion(chosen);
            typedSince.current = true;
            setSaid(null);
            // Back to the number: leaving it keeps it under the code chosen.
            field.current?.focus();
          }}
        />
      )}
      {said !== null && answerWords !== null && (
        <View className="gap-2">
          <View className="flex-row items-start gap-2">
            {REFUSED.has(said.notice) && (
              <Icon as={CircleAlert} size={18} className="mt-0.5 text-foreground" />
            )}
            <View className="flex-1">
              <Said words={answerWords} refused={REFUSED.has(said.notice)} answer={said.answer} />
            </View>
          </View>
          {(said.notice === "pace" || said.notice === "failed") && (
            <Button
              variant="outline"
              className="self-start"
              disabled={busy}
              onPress={() => {
                tap();
                leave();
              }}
            >
              {t("settings.contacts.retry")}
            </Button>
          )}
        </View>
      )}
    </View>
  );
}

/** What each answer says, for the kind. */
function wordsOf(
  t: ReturnType<typeof useT>["t"],
  kind: ContactKind,
  notice: Notice,
  code: string,
): string {
  switch (notice) {
    case "saved":
      return t("settings.contacts.saved");
    case "removed":
      return t("settings.contacts.removed");
    case "stillSaved":
      return t("settings.contacts.stillSaved");
    case "invalid":
      return t("settings.contacts.invalid", { kind });
    case "phoneShort":
      return t("settings.contacts.phoneShort");
    case "phoneLong":
      return t("settings.contacts.phoneLong");
    case "phoneInvalid":
      return t("settings.contacts.phoneInvalid", { code });
    case "pace":
      return t("chat.contact.error.message_budget_exceeded");
    case "failed":
      return t("settings.contacts.failed");
  }
}

/** The kinds kept, in the list's order, for the row's value; a module's function, so the row's read stays the same one. */
const readKept = () =>
  fetchContacts().then((contacts) =>
    CONTACT_KINDS.filter((kind) => contacts.some((contact) => contact.kind === kind)),
  );

/** The Ways to reach you row's value in Settings (#376, #511): the kinds kept, by name, or none. */
export function useContactsSummary(enabled: boolean) {
  const { t } = useT();
  const { data, stored } = useRowData<readonly ContactKind[]>(readKept, enabled);
  const summary =
    data === undefined
      ? undefined
      : data.length === 0
        ? t("settings.contacts.none")
        : data
            .map((kind) => t("settings.contacts.title", { kind }))
            .join(t("settings.contacts.separator"));
  return { summary, stored };
}
