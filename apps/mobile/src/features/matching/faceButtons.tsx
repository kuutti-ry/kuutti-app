import type { LucideIcon } from "lucide-react-native";
import Heart from "lucide-react-native/icons/heart";
import X from "lucide-react-native/icons/x";
import { Path } from "react-native-svg";
import { drawn } from "@/components/ui/icon";
import type { ButtonStyle } from "@/lib/decision-buttons";

/** The disc, on Lucide's grid with its one point of padding. */
const DISC = "M23 12a11 11 0 1 1-22 0a11 11 0 1 1 22 0Z";

/**
 * A controller's face button in one ink (#520): a disc with its mark cut out,
 * by the even-odd rule, in the 2-point line of the other icons, so the
 * button's own colour shows through in all four token sets. Our own drawings,
 * until #410's set takes them into its line, and never a console's colours,
 * logo or button artwork (.claude/rules/mobile.md).
 */
const faceButton = (name: string, mark: string) =>
  drawn(name, <Path d={`${DISC}${mark}`} fill="currentColor" fillRule="evenodd" stroke="none" />);

export type DecisionIcons = { like: LucideIcon; pass: LucideIcon };

/**
 * Like's and Pass's icons in each style of the setting (#520), Like on the
 * mark that confirms and Pass on the one that goes back: ✕ and ○ on one
 * console, A and B on two others. Only the icon changes. Each button keeps
 * its shape, word, place and spoken name, the word carries the meaning, for
 * whom a ✕ reads as no, and the fish and Undo keep their own icons, so no
 * more than these two shapes are ever on the screen.
 */
export const DECISION_ICONS: Readonly<Record<ButtonStyle, DecisionIcons>> = {
  kuutti: { like: Heart, pass: X },
  shapes: {
    like: faceButton(
      "FaceCross",
      "M12 10.59L15.79 6.79A1 1 0 0 1 17.21 8.21L13.41 12L17.21 15.79A1 1 0 0 1 15.79 17.21L12 13.41L8.21 17.21A1 1 0 0 1 6.79 15.79L10.59 12L6.79 8.21A1 1 0 0 1 8.21 6.79Z",
    ),
    pass: faceButton(
      "FaceCircle",
      "M18.5 12a6.5 6.5 0 1 1-13 0a6.5 6.5 0 1 1 13 0ZM16.5 12a4.5 4.5 0 1 0-9 0a4.5 4.5 0 1 0 9 0Z",
    ),
  },
  letters: {
    like: faceButton(
      "FaceA",
      "M11.06 5.65A1 1 0 0 1 12.94 5.65L17.44 17.65A1 1 0 0 1 15.56 18.35L14.31 15H9.69L8.44 18.35A1 1 0 0 1 6.56 17.65ZM12 8.85L13.56 13H10.44Z",
    ),
    pass: faceButton(
      "FaceB",
      "M7 6A1 1 0 0 1 8 5H12.5A4 4 0 0 1 15.38 11.78A4 4 0 0 1 13 19H8A1 1 0 0 1 7 18ZM9 7H12.5A2 2 0 0 1 12.5 11H9ZM9 13H13A2 2 0 0 1 13 17H9Z",
    ),
  },
};
