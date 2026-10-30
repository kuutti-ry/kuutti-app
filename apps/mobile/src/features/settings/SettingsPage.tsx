import { useRouter } from "expo-router";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  ScrollView,
  type View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useT } from "@/lib/locale";
import { useReducedMotion } from "@/theme/useReducedMotion";

type ScrollProps = {
  ref: RefObject<ScrollView | null>;
  onLayout: (event: { nativeEvent: { layout: { height: number } } }) => void;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onContentSizeChange: () => void;
  onTouchStart: () => void;
  scrollEventThrottle: number;
};

/** The longest a reveal keeps its part in sight as the page settles, if the person does not move the list first. */
const SETTLING_MS = 10_000;

/** How long after the reveal's own scroll a scroll is still taken for its. */
const OWN_SCROLL_MS = 1000;

/**
 * Brings a part of the page into sight (#511), as a row of Settings opens
 * low on the list, or above the page's top: the page scrolls by the least
 * that shows the whole part, never so far that the part's top goes above
 * the page's top, so a part taller than the page shows from its top.
 * Nothing scrolls when the part is in sight already, and the scroll is
 * instant under reduce motion. Its `scrollProps` go to the page
 * (SettingsPage).
 */
export function useReveal(): { scrollProps: ScrollProps; reveal: (part: View) => void } {
  const reduced = useReducedMotion();
  const ref = useRef<ScrollView | null>(null);
  const page = useRef({ height: 0, offset: 0 });
  // The part last revealed, checked again as the page settles: opened by a
  // link, a row is revealed before the safe area's insets have shortened the
  // page, which would count the bottom of it as in sight; a row that comes
  // back open is revealed before the rows above it have read their values,
  // which then push it down; and a panel grows as its own values arrive,
  // seconds later on a slow network. The person's first move ends it, so that
  // nothing they then do moves the list under them: a touch on the list, the
  // keyboard coming up for a field (chosen by touch or by a screen reader's
  // double tap), or a scroll that is not the reveal's own (a screen reader's
  // swipe through a tall panel).
  const pending = useRef<{ part: View; at: number } | null>(null);
  const scrolled = useRef(0);
  const end = useCallback(() => {
    pending.current = null;
  }, []);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", end);
    return () => shown.remove();
  }, [end]);
  const check = useCallback(
    (part: View) => {
      // Android's page is shortened for the keyboard until it has gone
      // (SettingsPage): a row tapped while typing is measured again as the
      // page grows back, not against the shortened one.
      if (Platform.OS === "android" && Keyboard.isVisible()) return;
      // The content's own view, which RN 0.86 has but its ScrollView.d.ts does not name yet.
      const content = (
        ref.current as unknown as { getInnerViewRef?: () => View | null } | null
      )?.getInnerViewRef?.();
      if (!content) return;
      part.measureLayout(content, (_x, top, _width, height) => {
        const { height: shown, offset } = page.current;
        const bottom = top + height;
        if (top >= offset && bottom <= offset + shown) return;
        // Above the page's top, as when the open row above the one tapped
        // closed and the list moved up under the finger: down to its top.
        const y = top < offset ? top : Math.min(bottom - shown, top);
        scrolled.current = Date.now();
        ref.current?.scrollTo({ y, animated: !reduced });
      });
    },
    [reduced],
  );
  const reveal = useCallback(
    (part: View) => {
      pending.current = { part, at: Date.now() };
      check(part);
    },
    [check],
  );
  const onContentSizeChange = useCallback(() => {
    const recent = pending.current;
    if (recent && Date.now() - recent.at < SETTLING_MS) check(recent.part);
  }, [check]);
  const onLayout = useCallback(
    (event: { nativeEvent: { layout: { height: number } } }) => {
      page.current.height = event.nativeEvent.layout.height;
      onContentSizeChange();
    },
    [onContentSizeChange],
  );
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = event.nativeEvent.contentOffset.y;
      const moved = Math.abs(offset - page.current.offset) >= 1;
      page.current.offset = offset;
      if (moved && Date.now() - scrolled.current > OWN_SCROLL_MS) end();
    },
    [end],
  );
  return {
    scrollProps: {
      ref,
      onLayout,
      onScroll,
      onContentSizeChange,
      onTouchStart: end,
      // Every frame's offset: Android drops the scroll's last event under a
      // longer throttle, and the offset is what the next reveal measures from.
      scrollEventThrottle: 16,
    },
    reveal,
  };
}

/**
 * One screen a settings row opens (#287), and the list itself (#511): the
 * pinned way back, and the settings below it. A field low on the page stays in sight above the
 * keyboard (#103, the contacts' last card): iOS insets the scroll view and
 * scrolls the field up itself. Android draws the app edge to edge, so the
 * window no longer resizes for the keyboard (as in the conversation's
 * composer): the padding ends the scroll view at the keyboard's top, and
 * Android's scroll view then scrolls the focused field into view as it
 * shrinks. Padding on iOS too would take the keyboard's height twice.
 */
export function SettingsPage({
  title,
  children,
  scrollProps,
}: {
  title: string;
  children: ReactNode;
  /** The page's scroll for useReveal, on a page that brings parts into sight. */
  scrollProps?: ScrollProps;
}) {
  const { t } = useT();
  const router = useRouter();
  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={title}
        backLabel={t("settings.back")}
        onBack={() => {
          // A field the arrow leaves counts as left, and saves (#511).
          Keyboard.dismiss();
          router.back();
        }}
      />
      <KeyboardAvoidingView
        className="flex-1"
        behavior="padding"
        enabled={Platform.OS === "android"}
      >
        <ScrollView
          {...scrollProps}
          contentContainerClassName="gap-6 p-6"
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
