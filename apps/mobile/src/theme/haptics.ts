import * as Haptics from "expo-haptics";
import { useCallback } from "react";
import { Platform } from "react-native";
import { useReducedMotion } from "./useReducedMotion";

/**
 * A light tap for a completed action. Silent when reduce-motion is on (#12:
 * people who switch motion off rarely want the phone to buzz instead) and on
 * web, where there is nothing to buzz.
 */
export function useHapticTap(): () => void {
  const reduced = useReducedMotion();
  return useCallback(() => {
    if (reduced || Platform.OS === "web") return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [reduced]);
}

/**
 * A warning felt as a refusal or a failure is said (#511): a contact the app
 * cannot read, a save that did not go through. Gated as the tap is; a save
 * that went through is said in words and felt as nothing.
 */
export function useHapticWarning(): () => void {
  const reduced = useReducedMotion();
  return useCallback(() => {
    if (reduced || Platform.OS === "web") return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }, [reduced]);
}
