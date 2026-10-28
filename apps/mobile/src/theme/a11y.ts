/**
 * The accessibility baseline as constants (#12, CLAUDE.md Accessibility), so
 * components and their tests agree on one number.
 */
import { Platform } from "react-native";

/** Minimum touch target edge in points. */
export const TOUCH_TARGET = 44;

/**
 * Hides a purely decorative element (an icon beside its label, the logo above
 * the name) from screen readers, with each platform's own props: on web,
 * react-native-svg and expo-image hand unknown props straight to the DOM.
 */
export const DECORATIVE = Platform.select({
  web: { "aria-hidden": true },
  default: { accessibilityElementsHidden: true, importantForAccessibility: "no" as const },
});

/** Text follows the OS font size up to this factor; layouts must survive it. */
export const MAX_FONT_SCALE = 2;

/**
 * Headings follow it less, the larger they are drawn, as iOS's own type ramp
 * and Android 14's nonlinear font scaling do (#467): at the largest size h1 is
 * 39 pt, h2 38, h3 37 and h4 35 over body text's 28, so the levels keep their
 * order, and the longest Finnish words of the headings outside ScreenHeader
 * ("Odotellessasi", "yhdistäminen") fit a 320 pt phone unbroken in the system
 * font. h4 is already about the size of large text and takes MAX_FONT_SCALE.
 */
export const HEADING_FONT_SCALE = { h1: 1.25, h2: 1.45, h3: 1.75 } as const;

/**
 * hitSlop that extends a control drawn smaller than the minimum target (a
 * switch, a close icon) to TOUCH_TARGET in both directions.
 */
export function hitSlopFor(width: number, height: number) {
  const horizontal = Math.max(0, Math.ceil((TOUCH_TARGET - width) / 2));
  const vertical = Math.max(0, Math.ceil((TOUCH_TARGET - height) / 2));
  return { top: vertical, bottom: vertical, left: horizontal, right: horizontal };
}
