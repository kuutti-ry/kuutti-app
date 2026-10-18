import {
  CONTACT_INPUT_MAX,
  CONTACT_KINDS,
  type ContactKind,
  normaliseContact,
} from "@kuutti/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { LoadFailed } from "@/components/LoadFailed";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { fetchContacts, removeContact, saveContact } from "./client";

type Stored = Partial<Record<ContactKind, string | undefined>>;
type Notice = "saved" | "removed" | "invalid" | "pace" | "failed" | null;

/** A number is typed as one, on the phone's number pad; neither is capitalised or corrected. */
const NUMBER: ReadonlySet<ContactKind> = new Set(["phone", "whatsapp"]);

/**
 * The person's contacts (#103), on Settings' Your contacts screen: the line
 * that nobody sees them until one is shared in a conversation, then a card
 * per kind (phone number, WhatsApp, Telegram, Instagram). While they are
 * being read it says so; a read that failed says why, with a way to read them
 * again.
 */
export function YourContacts() {
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
      {CONTACT_KINDS.map((kind) => (
        <ContactCard
          key={kind}
          kind={kind}
          stored={stored[kind] ?? null}
          onStored={(value) => setStored((was) => ({ ...was, [kind]: value ?? undefined }))}
        />
      ))}
    </View>
  );
}

/**
 * One kind as a card, as the e-mail's (#148): its name and what to type, the
 * field with what is kept in its stored form, Save (off while empty or
 * unchanged) and Remove (only while one is kept). What is typed is checked
 * on the phone first, with the API's own rule, and a refusal of either is
 * said in words for the kind; a keep or a removal counts with the messages
 * of a minute, and one past them is said as the share dialog says it. The
 * words stay in the field.
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
  const { t } = useT();
  const tap = useHapticTap();
  const [typed, setTyped] = useState(stored ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const run = async (call: () => Promise<string | null>, done: "saved" | "removed") => {
    setBusy(true);
    setNotice(null);
    try {
      const value = await call();
      onStored(value);
      setTyped(value ?? "");
      setNotice(done);
    } catch (error) {
      const refused = error instanceof ApiError ? error : null;
      setNotice(
        refused?.status === 400
          ? "invalid"
          : refused?.code === "message_budget_exceeded"
            ? "pace"
            : "failed",
      );
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    tap();
    if (normaliseContact(kind, typed) === null) {
      setNotice("invalid");
      return;
    }
    void run(async () => (await saveContact(kind, typed.trim())).value, "saved");
  };

  const words = typed.trim();
  // What would be stored as it is already (the stored form, or one that becomes it): nothing to save.
  const unchanged = stored !== null && normaliseContact(kind, words) === stored;
  const number = NUMBER.has(kind);
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{t("settings.contacts.title", { kind })}</CardTitle>
        <CardDescription>{t("settings.contacts.hint", { kind })}</CardDescription>
      </CardHeader>
      <CardContent className="gap-3">
        <Input
          accessibilityLabel={t("settings.contacts.input", { kind })}
          value={typed}
          maxLength={CONTACT_INPUT_MAX}
          inputMode={number ? "tel" : "text"}
          autoComplete={number ? "tel" : "off"}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          onChangeText={(text) => {
            setNotice(null);
            setTyped(text);
          }}
        />
        {notice && (
          <Text accessibilityLiveRegion="assertive">
            {notice === "saved"
              ? t("settings.contacts.saved")
              : notice === "removed"
                ? t("settings.contacts.removed")
                : notice === "invalid"
                  ? t("settings.contacts.invalid", { kind })
                  : notice === "pace"
                    ? t("chat.contact.error.message_budget_exceeded")
                    : t("settings.contacts.failed")}
          </Text>
        )}
        <Button
          disabled={busy || words.length === 0 || unchanged}
          accessibilityLabel={t("settings.contacts.saveLabel", { kind })}
          onPress={save}
        >
          {t("settings.contacts.save")}
        </Button>
        {stored !== null && (
          <Button
            variant="outline"
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
      </CardContent>
    </Card>
  );
}
