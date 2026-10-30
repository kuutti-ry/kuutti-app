import { formatTime, type PlainMessageKey } from "@kuutti/i18n";
import { type AccountEmailResponse, EMAIL_CODE_LENGTH, EMAIL_MAX } from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { DEAL_BREAKERS_PATH } from "@/features/profile";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/locale";
import { useRowData } from "@/lib/row-data";
import { useReportUnsaved } from "@/lib/unsaved";
import { useHapticTap } from "@/theme/haptics";
import { clearEmail, confirmEmailCode, fetchEmail, saveEmail, sendEmailCode } from "./email-client";
import { useLockOfferDue } from "./lock/LockProvider";
import { useSession } from "./session";

type Notice =
  | "saved"
  | "invalid"
  | "failed"
  | "confirmedNow"
  | "codeWrong"
  | "codeSpent"
  | "codeExpired"
  | "codeNone"
  | "sendLimit"
  | "mailUnavailable"
  | "codeFailed";

const NOTICE: Readonly<Record<Notice, PlainMessageKey>> = {
  saved: "account.email.saved",
  invalid: "account.email.invalid",
  failed: "account.email.failed",
  confirmedNow: "account.email.confirmedNow",
  codeWrong: "account.email.codeWrong",
  codeSpent: "account.email.codeSpent",
  codeExpired: "account.email.codeExpired",
  codeNone: "account.email.codeNone",
  sendLimit: "account.email.sendLimit",
  mailUnavailable: "account.email.mailUnavailable",
  codeFailed: "account.email.codeFailed",
};

/** The code routes' refusals in the card's words (ADR-043 §3); any other says codeFailed. */
const REFUSALS = new Map<string | undefined, Notice>([
  ["email_code_wrong", "codeWrong"],
  ["email_code_spent", "codeSpent"],
  ["email_code_expired", "codeExpired"],
  ["email_code_none", "codeNone"],
  ["email_code_budget_exceeded", "sendLimit"],
  ["mail_unavailable", "mailUnavailable"],
]);

/** The refusals after which no code waits: the card offers to send one again. */
const NO_CODE_LEFT = new Set<string | undefined>([
  "email_code_spent",
  "email_code_expired",
  "email_code_none",
]);

/**
 * The refusals that say the address changed on another phone meanwhile,
 * confirmed there or removed: the card reads it again and shows what the API
 * holds now.
 */
const CHANGED_ELSEWHERE = new Set<string | undefined>(["email_confirmed", "email_none"]);

/**
 * What a call says, line by line: one of the card's notices, or that a code
 * went and until when it works. A save that sends one says both.
 */
type Said = Notice | { codeSentUntil: string };

type Load =
  | { state: "loading" }
  | { state: "unavailable"; error: unknown }
  | { state: "ready"; email: AccountEmailResponse };

/**
 * The optional e-mail (#148, TD-18) as a card: the honest reason first, the
 * address, save and remove, and the code that confirms it (#385, ADR-043).
 * Never shown to anybody else and never a login; the API keeps it out of
 * every log line. Under its row in Settings (#287, #511), where the row's
 * title stands for the card's (`inRow`) and what the card holds goes to
 * `onStored` for the row to say, and as the last of the later screens. While
 * the address is being read it says so, and a read that failed says why,
 * with a way to read it again; nothing for a signed-out device.
 */
export function EmailCard({
  inRow = false,
  onStored,
}: {
  inRow?: boolean;
  onStored?: (email: AccountEmailResponse) => void;
}) {
  const { t } = useT();
  const session = useSession();
  const signedIn = session.status === "signed-in";
  const [load, setLoad] = useState<Load>({ state: "loading" });

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const read = useCallback(() => {
    setLoad({ state: "loading" });
    fetchEmail().then(
      (email) => {
        if (mounted.current) setLoad({ state: "ready", email });
      },
      (error: unknown) => {
        if (mounted.current) setLoad({ state: "unavailable", error });
      },
    );
  }, []);
  useEffect(() => {
    if (signedIn) read();
  }, [signedIn, read]);

  if (!signedIn) return null;
  if (load.state === "loading") {
    return (
      <Text variant="muted" accessibilityLiveRegion="polite">
        {t("account.email.loading")}
      </Text>
    );
  }
  if (load.state === "unavailable") {
    return (
      <LoadFailed headline={t("account.email.loadFailed")} error={load.error} onRetry={read} />
    );
  }
  return <EmailForm first={load.email} inRow={inRow} onStored={onStored} />;
}

/**
 * The card once the address is read: it holds what the API last answered,
 * whether a code waits included. The API answers none past the code's end, so
 * a card left open past it keeps the code's field until Confirm's answer says
 * the code expired. Every call clears the last notice and says its own, in a
 * live region and, on iOS, aloud.
 */
function EmailForm({
  first,
  inRow,
  onStored,
}: {
  first: AccountEmailResponse;
  inRow: boolean;
  onStored?: (email: AccountEmailResponse) => void;
}) {
  const { t, locale } = useT();
  const tap = useHapticTap();
  // Together, so an answer can tell whether the person has typed in the field
  // since the last one.
  const [{ stored, typed }, setForm] = useState({ stored: first, typed: first.email ?? "" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<readonly Said[]>([]);
  // Which answer the notice is: each one a fresh live region, so Android says
  // the same words again for a second code within the minute.
  const [answers, setAnswers] = useState(0);
  useEffect(() => onStored?.(stored), [stored, onStored]);
  // An address typed and not sent is not kept: Settings asks before it is left (#511).
  useReportUnsaved("email", typed.trim() !== "" && typed.trim() !== (stored.email ?? ""));
  // Whole sentences one after another; nothing is inflected around them.
  const wordsOf = (lines: readonly Said[]): string =>
    lines
      .map((line) =>
        typeof line === "string"
          ? t(NOTICE[line])
          : t("account.email.codeSent", {
              time: formatTime(locale, new Date(line.codeSentUntil)),
            }),
      )
      .join(" ");

  const run = async (call: () => Promise<readonly Said[]>) => {
    tap();
    setBusy(true);
    setSaid([]);
    try {
      const next = await call();
      setSaid(next);
      setAnswers((n) => n + 1);
      // iOS has no live regions; Android's speak the same words already. Said
      // for each call, not as the words change: a second code sent within the
      // minute has the same words as the first, and is said again.
      if (next.length > 0 && Platform.OS === "ios") {
        AccessibilityInfo.announceForAccessibility(wordsOf(next));
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * An answer to a send, a confirmation or a read again becomes the card's;
   * the field follows it while it still holds the address answered before,
   * so another phone's change shows, and what the person typed stays.
   */
  const adopt = (next: AccountEmailResponse) =>
    setForm((form) => ({
      stored: next,
      typed: form.typed === form.stored.email ? (next.email ?? "") : form.typed,
    }));

  /** A refused send or confirmation in words; the refusals that leave no code take the waiting one away. */
  const refused = async (error: unknown): Promise<readonly Said[]> => {
    const reason = error instanceof ApiError ? error.code : undefined;
    if (CHANGED_ELSEWHERE.has(reason)) {
      try {
        const now = await fetchEmail();
        adopt(now);
        return now.confirmed ? ["confirmedNow"] : [];
      } catch {
        return ["codeFailed"];
      }
    }
    if (NO_CODE_LEFT.has(reason)) {
      setForm((form) => ({ ...form, stored: { ...form.stored, codeExpiresAt: null } }));
    }
    return [REFUSALS.get(reason) ?? "codeFailed"];
  };

  const send = async (): Promise<readonly Said[]> => {
    let sent: AccountEmailResponse;
    try {
      sent = await sendEmailCode();
    } catch (error) {
      return refused(error);
    }
    adopt(sent);
    setCode("");
    // Narrowing only: a sent code is answered with until when it works.
    return sent.codeExpiresAt === null ? [] : [{ codeSentUntil: sent.codeExpiresAt }];
  };

  const confirm = async (): Promise<readonly Said[]> => {
    try {
      adopt(await confirmEmailCode(code));
      return ["confirmedNow"];
    } catch (error) {
      return refused(error);
    } finally {
      setCode("");
    }
  };

  /** A save or a removal, and the one code a new address gets. */
  const keep = async (call: () => Promise<AccountEmailResponse>): Promise<readonly Said[]> => {
    let next: AccountEmailResponse;
    try {
      next = await call();
    } catch (error) {
      return [error instanceof ApiError && error.status === 400 ? "invalid" : "failed"];
    }
    setForm({ stored: next, typed: next.email ?? "" });
    setCode("");
    // Setting or changing an address sends its confirmation (#385). The save
    // itself sends nothing, so a send that fails leaves the address saved:
    // "Saved.", then what the send says (ADR-043 §2).
    const needsCode = next.email !== null && !next.confirmed && next.codeExpiresAt === null;
    return needsCode ? ["saved", ...(await send())] : ["saved"];
  };

  const words = said.length === 0 ? null : wordsOf(said);
  const address = typed.trim();
  const fields = (
    <>
      {/* Its name in sight too, as the code's field has it, not only for a screen reader. */}
      <Text variant="small">{t("account.email.label")}</Text>
      <Input
        accessibilityLabel={t("account.email.label")}
        value={typed}
        maxLength={EMAIL_MAX}
        autoCapitalize="none"
        autoCorrect={false}
        inputMode="email"
        autoComplete="email"
        // The keyboard's own key does what the button under the field does.
        returnKeyType="send"
        onSubmitEditing={() => {
          if (!busy && address.length > 0 && address !== stored.email) {
            void run(() => keep(() => saveEmail(address)));
          }
        }}
        onChangeText={(text) => {
          setSaid([]);
          setForm((form) => ({ ...form, typed: text }));
        }}
      />
      {stored.email !== null && (
        <Text variant="muted">
          {stored.confirmed ? t("account.email.confirmed") : t("account.email.unconfirmed")}
        </Text>
      )}
      <Button
        disabled={busy || address.length === 0 || address === stored.email}
        onPress={() => void run(() => keep(() => saveEmail(address)))}
      >
        {t("account.email.save")}
      </Button>
      {stored.email !== null && !stored.confirmed && (
        <CodeSection
          expiresAt={stored.codeExpiresAt}
          code={code}
          busy={busy}
          onCode={(text) => {
            setSaid([]);
            setCode(text.replace(/\D/g, "").slice(0, EMAIL_CODE_LENGTH));
          }}
          onConfirm={() => void run(confirm)}
          onSend={() => void run(send)}
        />
      )}
      {words !== null && (
        <Text key={answers} accessibilityLiveRegion="assertive">
          {words}
        </Text>
      )}
      {stored.email !== null && (
        <Button variant="outline" disabled={busy} onPress={() => void run(() => keep(clearEmail))}>
          {t("account.email.clear")}
        </Button>
      )}
    </>
  );
  // In a row of Settings the row's title names it: no card inside the list's card (#511).
  if (inRow) {
    return (
      <View className="gap-3">
        <Text>{t("account.email.explain")}</Text>
        {fields}
      </View>
    );
  }
  return (
    <Card className="w-full max-w-md">
      <View accessibilityLabel={t("account.email.title")} className="gap-4">
        <CardHeader>
          <CardTitle>{t("account.email.title")}</CardTitle>
          <CardDescription>{t("account.email.explain")}</CardDescription>
        </CardHeader>
        <CardContent className="gap-3">{fields}</CardContent>
      </View>
    </Card>
  );
}

/**
 * The unconfirmed address's code (#385, ADR-043 §3): while one waits, until
 * when, its six digits and Confirm, and a new one on request; while none
 * waits, the way to ask for one.
 */
function CodeSection({
  expiresAt,
  code,
  busy,
  onCode,
  onConfirm,
  onSend,
}: {
  /** Until when the waiting code works; null when none waits. */
  expiresAt: string | null;
  code: string;
  busy: boolean;
  onCode: (text: string) => void;
  onConfirm: () => void;
  onSend: () => void;
}) {
  const { t, locale } = useT();
  if (expiresAt === null) {
    return (
      <Button disabled={busy} onPress={onSend}>
        {t("account.email.send")}
      </Button>
    );
  }
  return (
    <View className="gap-3">
      {/* The phone's own clock, not Helsinki's as in a conversation: one reader,
          who holds the time against the clock at the top of the same screen.
          No live region: the card's notice says it as each code goes. */}
      <Text>{t("account.email.codeSent", { time: formatTime(locale, new Date(expiresAt)) })}</Text>
      <View className="gap-2">
        <Text variant="small">{t("account.email.codeLabel")}</Text>
        <Input
          accessibilityLabel={t("account.email.codeLabel")}
          value={code}
          maxLength={EMAIL_CODE_LENGTH}
          inputMode="numeric"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          onChangeText={onCode}
        />
      </View>
      <Button disabled={busy || code.length !== EMAIL_CODE_LENGTH} onPress={onConfirm}>
        {t("account.email.confirm")}
      </Button>
      <Button variant="outline" disabled={busy} onPress={onSend}>
        {t("account.email.sendAgain")}
      </Button>
    </View>
  );
}

/**
 * The e-mail among the later screens (#148): the card, and the way on, to
 * the lock's one offer (#418) or home. It scrolls, so at the largest text every line and every button can
 * still be reached (#217), and it keeps the code's field and Confirm above
 * the keyboard as a settings screen does (SettingsPage, #103): iOS insets the
 * scroll view itself; Android draws edge to edge, so the padding ends the
 * scroll view at the keyboard's top. Padding on iOS too would take the
 * keyboard's height twice.
 */
export function EmailScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  // The lock comes after the e-mail, once (#418); home when it was offered or is on.
  const lockOfferDue = useLockOfferDue();
  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView
        className="flex-1"
        behavior="padding"
        enabled={Platform.OS === "android"}
      >
        <ScrollView
          contentContainerClassName="flex-grow items-center gap-6 p-6"
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          <Text variant="h1" accessibilityRole="header">
            {t("profile.later.title")}
          </Text>
          <EmailCard />
          <Text>{t("profile.later.done")}</Text>
          {/* The deal-breakers come after the optional fields (#149): one tap, never required. */}
          <Button
            variant="outline"
            onPress={() => {
              tap();
              router.push(DEAL_BREAKERS_PATH);
            }}
          >
            {t("profile.dealBreakers.open")}
          </Button>
          <Button
            onPress={() => {
              tap();
              router.replace(lockOfferDue ? "/account/lock" : "/");
            }}
          >
            {t("account.email.done")}
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/**
 * The e-mail row's value in Settings (#376, #511): the address once
 * confirmed, the address and that it waits for its code, or that there is
 * none; nothing until it has been read.
 */
export function useEmailSummary(enabled: boolean) {
  const { t } = useT();
  const { data, stored } = useRowData(fetchEmail, enabled);
  const summary =
    data === undefined
      ? undefined
      : data.email === null
        ? t("settings.email.none")
        : data.confirmed
          ? data.email
          : t("settings.email.unconfirmed", { address: data.email });
  // An address waiting for its code does not reach the person yet: the row marks it (#511).
  const alert = data !== undefined && data.email !== null && !data.confirmed;
  return { summary, alert, stored };
}
