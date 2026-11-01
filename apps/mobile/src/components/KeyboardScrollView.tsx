import type { ComponentProps, RefAttributes } from "react";
import { KeyboardAvoidingView, Platform, ScrollView } from "react-native";

/**
 * A page with a field on it, kept in sight above the keyboard (#103): iOS
 * insets the scroll view and scrolls the field up itself. Android draws the
 * app edge to edge, so the window no longer resizes for the keyboard (as in
 * the conversation's composer): the padding ends the scroll view at the
 * keyboard's top, and Android's scroll view then scrolls the focused field
 * into view as it shrinks. Padding on iOS too would take the keyboard's height
 * twice. A tap on a button under the field counts with the keyboard up.
 */
export function KeyboardScrollView(
  props: ComponentProps<typeof ScrollView> & RefAttributes<ScrollView>,
) {
  return (
    <KeyboardAvoidingView className="flex-1" behavior="padding" enabled={Platform.OS === "android"}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        {...props}
      />
    </KeyboardAvoidingView>
  );
}
