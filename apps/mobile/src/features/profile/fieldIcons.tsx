import type { ProfileFieldKey } from "@kuutti/schema";
import type { LucideIcon, LucideProps } from "lucide-react-native";
import Baby from "lucide-react-native/icons/baby";
import Beer from "lucide-react-native/icons/beer";
import BookOpen from "lucide-react-native/icons/book-open";
import Briefcase from "lucide-react-native/icons/briefcase";
import Cigarette from "lucide-react-native/icons/cigarette";
import Compass from "lucide-react-native/icons/compass";
import Dumbbell from "lucide-react-native/icons/dumbbell";
import EyeOff from "lucide-react-native/icons/eye-off";
import GraduationCap from "lucide-react-native/icons/graduation-cap";
import HeartHandshake from "lucide-react-native/icons/heart-handshake";
import IdCard from "lucide-react-native/icons/id-card";
import Languages from "lucide-react-native/icons/languages";
import MoonStar from "lucide-react-native/icons/moon-star";
import PawPrint from "lucide-react-native/icons/paw-print";
import Pill from "lucide-react-native/icons/pill";
import Ruler from "lucide-react-native/icons/ruler";
import Shapes from "lucide-react-native/icons/shapes";
import Sprout from "lucide-react-native/icons/sprout";
import User from "lucide-react-native/icons/user";
import Vote from "lucide-react-native/icons/vote";
import type * as React from "react";
import { forwardRef } from "react";
import { View } from "react-native";
import Svg, { Ellipse, Path } from "react-native-svg";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { cn } from "@/lib/utils";
import { fieldLabelKey } from "./keys";

/**
 * An icon drawn here in Lucide's grid and line (24 points, a 2-point stroke
 * in the text colour, round ends), for what Lucide has no icon for. Taken by
 * Icon like any of Lucide's.
 */
function drawn(name: string, children: React.ReactNode): LucideIcon {
  const Drawn = forwardRef<Svg, LucideProps>(
    (
      {
        size = 24,
        color = "currentColor",
        strokeWidth = 2,
        absoluteStrokeWidth: _absolute,
        ...props
      },
      ref,
    ) => (
      <Svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...props}
      >
        {children}
      </Svg>
    ),
  );
  Drawn.displayName = name;
  return Drawn as LucideIcon;
}

/** A round tin of snus, lid and rim, seen from a little above. */
const SnusCan = drawn(
  "SnusCan",
  <>
    <Ellipse cx="12" cy="9" rx="9" ry="3" />
    <Path d="M3 9v6c0 1.66 4.03 3 9 3s9-1.34 9-3V9" />
    <Path d="M3 11.5c0 1.66 4.03 3 9 3s9-1.34 9-3" />
  </>,
);

/** Two open hands held up side by side, palms up, praying: the generic sign of religion. */
const PalmsUp = drawn(
  "PalmsUp",
  <>
    <Path d="M11 21V6a2.5 2.5 0 0 0-5 0v7l-1.8-1.8a1.4 1.4 0 0 0-2 2L6 17.5c.7 2.1 1.8 3.5 3.5 3.5H11z" />
    <Path d="M13 21V6a2.5 2.5 0 0 1 5 0v7l1.8-1.8a1.4 1.4 0 0 1 2 2L18 17.5c-.7 2.1-1.8 3.5-3.5 3.5H13z" />
  </>,
);

/**
 * One icon for each field of the registry (#239), before its label in the
 * sections, the later screens, the deal-breakers and on the card: a beer for
 * drinking, a cigarette for smoking, a tin for snus. Placeholders until the
 * designer draws the set; decorative, so the label alone names the field.
 * The religion's options keep their own symbols (glyphs.tsx).
 */
export const FIELD_ICONS: Readonly<Record<ProfileFieldKey, LucideIcon>> = {
  intent: Compass,
  identityLabel: User,
  monogamy: HeartHandshake,
  hasKids: Baby,
  wantsKids: Sprout,
  smoking: Cigarette,
  nicotine: SnusCan,
  languages: Languages,
  education: GraduationCap,
  drinking: Beer,
  drugsAttitude: Pill,
  hobbies: Shapes,
  height: Ruler,
  exercise: Dumbbell,
  pets: PawPrint,
  field: BookOpen,
  hideFromField: EyeOff,
  occupation: Briefcase,
  occupationTitle: IdCard,
  politics: Vote,
  religion: PalmsUp,
  zodiac: MoonStar,
};

/** A field's label with its icon before it. */
export function FieldLabel({ field, className }: { field: ProfileFieldKey; className?: string }) {
  const { t } = useT();
  return (
    <View className={cn("flex-row items-center gap-2", className)}>
      <Icon as={FIELD_ICONS[field]} size={16} testID={`field-icon-${field}`} />
      <Text variant="small" className="shrink">
        {t(fieldLabelKey(field))}
      </Text>
    </View>
  );
}
