import { useRouter } from "expo-router";
import { type ReactNode, type RefObject, useCallback, useRef } from "react";
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
  scrollEventThrottle: number;
};

/**
 * Brings a part of the page into sight (#511), as a row of Settings opens
 * low on the list: the page scrolls by the least that shows the whole part,
 * never so far that the part's top goes above the page's top, so a part
 * taller than the page shows from its top. Nothing scrolls when the part is
 * in sight already, and the scroll is instant under reduce motion. Its
 * `scrollProps` go to the page (SettingsPage).
 */
export function useReveal(): { scrollProps: ScrollProps; reveal: (part: View) => void } {
  const reduced = useReducedMotion();
  const ref = useRef<ScrollView | null>(null);
  const page = useRef({ height: 0, offset: 0 });
  const onLayout = useCallback((event: { nativeEvent: { layout: { height: number } } }) => {
    page.current.height = event.nativeEvent.layout.height;
  }, []);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    page.current.offset = event.nativeEvent.contentOffset.y;
  }, []);
  const reveal = useCallback(
    (part: View) => {
      // The content's own view, which RN 0.86 has but its ScrollView.d.ts does not name yet.
      const content = (
        ref.current as unknown as { getInnerViewRef?: () => View | null } | null
      )?.getInnerViewRef?.();
      if (!content) return;
      part.measureLayout(content, (_x, top, _width, height) => {
        const { height: shown, offset } = page.current;
        if (top + height <= offset + shown) return;
        ref.current?.scrollTo({ y: Math.min(top + height - shown, top), animated: !reduced });
      });
    },
    [reduced],
  );
  return {
    scrollProps: { ref, onLayout, onScroll, scrollEventThrottle: 100 },
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
