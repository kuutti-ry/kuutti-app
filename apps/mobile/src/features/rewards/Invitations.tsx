import { formatDateTime, type PlainMessageKey } from "@kuutti/i18n";
import type {
  InvitationCreated,
  InvitationReward,
  Invitations as InvitationsAnswer,
  OpenInvitation,
} from "@kuutti/schema";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Platform, Share, View } from "react-native";
import { LoadFailed } from "@/components/LoadFailed";
import { sayAloud } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Text } from "@/components/ui/text";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/locale";
import { useRevealOn } from "@/lib/reveal";
import { useRowData } from "@/lib/row-data";
import { useHapticTap } from "@/theme/haptics";
import { fetchInvitations, makeInvitation, withdrawInvitation } from "./client";
import { RedeemInvitation } from "./RedeemInvitation";
import { useInvitations } from "./useInvitations";
import { rewardParams } from "./words";

type Notice =
  | "made"
  | "makeFailed"
  | "full"
  | "notYet"
  | "withdrawn"
  | "withdrawFailed"
  | "shareFailed";

const NOTICE: Readonly<Record<Notice, PlainMessageKey>> = {
  made: "settings.invite.made",
  makeFailed: "load.failed.press",
  full: "errors.invitations_full",
  notYet: "errors.invitation_not_yet",
  withdrawn: "settings.invite.withdrawn",
  withdrawFailed: "load.failed.press",
  shareFailed: "settings.invite.shareFailed",
};

/** What the screen shows by itself: the code's card appears, the invitation leaves the list. Said, not drawn (#581), unless `run` finds the list not read. */
const SAID_ONLY: ReadonlySet<Notice> = new Set(["made", "withdrawn"]);

/** Making one refused in the API's own words (ADR-044 §5); any other failure says it could not be made. */
const MAKE_REFUSALS = new Map<string | undefined, Notice>([
  ["invitations_full", "full"],
  ["invitation_not_yet", "notYet"],
]);

/** A code as a screen reader says it: one character at a time, the two groups apart. */
const spoken = (code: string) =>
  code
    .split("-")
    .map((group) => [...group].join(" "))
    .join(", ");

/**
 * Settings › Invitations (#107, ADR-044), the settings slice's page around
 * it. For a person whose profile is complete: what an
 * invitation earns today in words, Create an invitation, the code just made
 * (large, selectable, read a character at a time, shown this once since
 * Kuutti keeps only its hash) with Share the code, which hands the phone's
 * sheet the invitation's message, until a read lists it no more; the open
 * invitations by when they were
 * made, each withdrawn after asking; what they earned that waits. Anybody else reads that invitations open once the profile is
 * complete. Somebody who may still type a code finds its field. Nothing here
 * names a friend, or says that one used a code and has not finished. A made or
 * withdrawn invitation shows by itself and is said aloud, with no line of its
 * own (#581); any other outcome is said in a live region and, on iOS, aloud. The
 * share sheet is injected, as the export's is (AccountActions), so tests see
 * what it was handed.
 */
export function Invitations({
  share = Share.share,
  onStored,
}: {
  share?: typeof Share.share;
  /** The invitations as read, again after each change, for the row above (#511). */
  onStored?: (invitations: InvitationsAnswer) => void;
}) {
  const { t, locale } = useT();
  const tap = useHapticTap();
  const view = useInvitations();
  const [made, setMade] = useState<InvitationCreated | null>(null);
  // Whether a read has listed the code just made. Once one has, a read
  // without it means the code works no more (a friend used it, or it was
  // withdrawn), and its card goes; until then a read that failed quietly
  // after the make hides nothing.
  const listedMade = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Which answer the notice is: each a fresh live region, so the same words are said again.
  const [answers, setAnswers] = useState(0);
  const [withdrawing, setWithdrawing] = useState<OpenInvitation | null>(null);
  const [redeemed, setRedeemed] = useState(false);
  // The code just made comes into sight: it is drawn below the button, nothing
  // else shows that it was made, and it must not stay under the screen's edge (#511, #581).
  const codeCard = useRevealOn(made?.id ?? null);

  const say = (next: Notice, drawn = !SAID_ONLY.has(next)) => {
    if (!drawn) {
      sayAloud(t(NOTICE[next]));
      return;
    }
    setNotice(next);
    setAnswers((n) => n + 1);
    // Android's live region speaks it; iOS has none.
    if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(t(NOTICE[next]));
  };

  /** One change at a time: the last notice goes, the list is read again after it, then what came of it is said. */
  const run = async (change: () => Promise<Notice>) => {
    setBusy(true);
    setNotice(null);
    const outcome = await change();
    const read = await view.refresh();
    // Only a read takes a withdrawn invitation off the list: without one it
    // still stands there, and the words are all that tell the eye.
    say(outcome, !SAID_ONLY.has(outcome) || (outcome === "withdrawn" && !read));
    setBusy(false);
  };

  const make = () =>
    run(async () => {
      try {
        const created = await makeInvitation();
        listedMade.current = false;
        setMade(created);
        return "made";
      } catch (error) {
        return (
          MAKE_REFUSALS.get(error instanceof ApiError ? error.code : undefined) ?? "makeFailed"
        );
      }
    });

  const withdraw = (invitation: OpenInvitation) =>
    run(async () => {
      try {
        await withdrawInvitation(invitation.id);
        // The code just made goes with its invitation: it works no more.
        setMade((shown) => (shown?.id === invitation.id ? null : shown));
        return "withdrawn";
      } catch {
        return "withdrawFailed";
      }
    });

  const answer = view.status === "ready" ? view.invitations : null;
  useEffect(() => {
    if (answer !== null) onStored?.(answer);
  }, [answer, onStored]);

  const listed = view.status === "ready" ? view.invitations.open : null;
  useEffect(() => {
    if (listed === null || made === null) return;
    if (listed.some((invitation) => invitation.id === made.id)) {
      listedMade.current = true;
    } else if (listedMade.current) {
      setMade(null);
    }
  }, [listed, made]);

  const shareCode = async (code: string, reward: InvitationReward) => {
    tap();
    try {
      await share({ message: t("invite.share.message", { code, ...rewardParams(reward) }) });
    } catch {
      say("shareFailed");
    }
  };

  if (view.status === "loading") {
    return (
      <Text variant="muted" accessibilityLiveRegion="polite">
        {t("load.loading")}
      </Text>
    );
  }
  if (view.status === "failed") {
    return <LoadFailed error={view.error} onRetry={view.retry} />;
  }
  const { canInvite, redeemable, reward, open, earned } = view.invitations;
  const earns = rewardParams(reward);

  return (
    <View className="gap-6">
      {canInvite ? (
        <>
          <View className="gap-3">
            {earns.reward !== "none" && (
              <>
                <Text>{t("settings.invite.earns", earns)}</Text>
                {/* Where many first meet the word, what it is, in place and with no (i) (#616). */}
                <Text variant="muted">{t("settings.invite.fish")}</Text>
              </>
            )}
            <Button
              disabled={busy}
              onPress={() => {
                tap();
                void make();
              }}
            >
              {t("settings.invite.make")}
            </Button>
            {notice !== null && (
              <Text key={answers} accessibilityLiveRegion="assertive">
                {t(NOTICE[notice])}
              </Text>
            )}
          </View>
          {made !== null && (
            // Kept a native view on Android, so that the page can measure it.
            <View
              ref={codeCard}
              collapsable={false}
              className="gap-3 rounded-lg border border-border p-4"
            >
              <Text variant="small">{t("settings.invite.code.label")}</Text>
              <Text
                selectable
                className="font-mono text-3xl font-semibold tracking-widest"
                accessibilityLabel={t("settings.invite.code.spoken", {
                  characters: spoken(made.code),
                })}
              >
                {made.code}
              </Text>
              <Text variant="muted">{t("settings.invite.code.once")}</Text>
              <Button onPress={() => void shareCode(made.code, reward)}>
                {t("settings.invite.share")}
              </Button>
            </View>
          )}
          {open.length > 0 && (
            <View className="gap-3">
              <Text variant="title">{t("settings.invite.open.title")}</Text>
              {open.map((invitation) => {
                const date = formatDateTime(locale, new Date(invitation.createdAt));
                return (
                  <View
                    key={invitation.id}
                    className="flex-row flex-wrap items-center justify-between gap-3"
                  >
                    <Text className="shrink grow">{t("settings.invite.open.made", { date })}</Text>
                    <Button
                      variant="outline"
                      accessibilityLabel={t("settings.invite.open.withdrawLabel", { date })}
                      disabled={busy}
                      onPress={() => {
                        tap();
                        setWithdrawing(invitation);
                      }}
                    >
                      {t("settings.invite.open.withdraw")}
                    </Button>
                  </View>
                );
              })}
            </View>
          )}
          {earned.fish > 0 && (
            <Text>{t("settings.invite.earned.fish", { fish: earned.fish })}</Text>
          )}
        </>
      ) : (
        <Text>{t("settings.invite.notYet")}</Text>
      )}
      {/* A code from a friend, while the profile is not complete (ADR-044 §6, ADR-060 §7). */}
      {(redeemable || redeemed) && (
        <View className="gap-3">
          <Text variant="title">{t("invite.redeem.title")}</Text>
          {redeemed ? (
            <Text accessibilityLiveRegion="polite">{t("invite.redeem.done")}</Text>
          ) : (
            <>
              {reward.friendFish > 0 && <Text>{t("invite.redeem.earns", earns)}</Text>}
              <RedeemInvitation
                onRedeemed={() => {
                  setRedeemed(true);
                  void view.refresh();
                }}
              />
            </>
          )}
        </View>
      )}

      {withdrawing !== null && (
        // Open while it asks: the close control and a tap outside are its only ways to change that.
        <Dialog open onOpenChange={() => setWithdrawing(null)}>
          <DialogContent closeLabel={t("settings.invite.withdraw.close")}>
            <DialogHeader>
              <DialogTitle>{t("settings.invite.withdraw.title")}</DialogTitle>
              <DialogDescription>{t("settings.invite.withdraw.body")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onPress={() => setWithdrawing(null)}>
                {t("settings.invite.withdraw.cancel")}
              </Button>
              <Button
                variant="destructive"
                onPress={() => {
                  setWithdrawing(null);
                  void withdraw(withdrawing);
                }}
              >
                {t("settings.invite.withdraw.confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </View>
  );
}

/**
 * The Invitations row's value in Settings (#376, #511): how many wait to be
 * used once the person may invite, or with none, what to do (#581); nothing
 * before, where the row's panel says when they may.
 */
export function useInvitationsSummary(enabled: boolean) {
  const { t } = useT();
  const { data, stored } = useRowData(fetchInvitations, enabled);
  const summary = data?.canInvite
    ? t("settings.invite.waiting", { waiting: data.open.length })
    : undefined;
  return { summary, stored };
}
