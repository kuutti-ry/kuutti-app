import type { PlainMessageKey } from "@kuutti/i18n";
import type { HobbyGroup, ProfileFieldKey } from "@kuutti/schema";
import type { LucideIcon } from "lucide-react-native";
import Baby from "lucide-react-native/icons/baby";
import Beer from "lucide-react-native/icons/beer";
import BookOpen from "lucide-react-native/icons/book-open";
import Briefcase from "lucide-react-native/icons/briefcase";
import Cigarette from "lucide-react-native/icons/cigarette";
import Compass from "lucide-react-native/icons/compass";
import Cpu from "lucide-react-native/icons/cpu";
import Dice5 from "lucide-react-native/icons/dice-5";
import Drama from "lucide-react-native/icons/drama";
import Dumbbell from "lucide-react-native/icons/dumbbell";
import EyeOff from "lucide-react-native/icons/eye-off";
import GraduationCap from "lucide-react-native/icons/graduation-cap";
import HeartHandshake from "lucide-react-native/icons/heart-handshake";
import House from "lucide-react-native/icons/house";
import IdCard from "lucide-react-native/icons/id-card";
import Languages from "lucide-react-native/icons/languages";
import Leaf from "lucide-react-native/icons/leaf";
import MoonStar from "lucide-react-native/icons/moon-star";
import Palette from "lucide-react-native/icons/palette";
import PawPrint from "lucide-react-native/icons/paw-print";
import Pill from "lucide-react-native/icons/pill";
import Plane from "lucide-react-native/icons/plane";
import Rabbit from "lucide-react-native/icons/rabbit";
import Ruler from "lucide-react-native/icons/ruler";
import Shapes from "lucide-react-native/icons/shapes";
import Sprout from "lucide-react-native/icons/sprout";
import Trees from "lucide-react-native/icons/trees";
import User from "lucide-react-native/icons/user";
import Users from "lucide-react-native/icons/users";
import Utensils from "lucide-react-native/icons/utensils";
import Volleyball from "lucide-react-native/icons/volleyball";
import Vote from "lucide-react-native/icons/vote";
import { View } from "react-native";
import { Ellipse, Path } from "react-native-svg";
import { drawn, Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { cn } from "@/lib/utils";
import { fieldLabelKey } from "./keys";

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

/** One icon for each group of hobbies (#239), before its heading in the picker; placeholders like the fields'. */
export const HOBBY_GROUP_ICONS: Readonly<Record<HobbyGroup, LucideIcon>> = {
  outdoors: Trees,
  sports: Volleyball,
  creative: Palette,
  food: Utensils,
  culture: Drama,
  games: Dice5,
  home: House,
  travel: Plane,
  animals: Rabbit,
  tech: Cpu,
  social: Users,
  wellbeing: Leaf,
};

/** A hobby group's heading with its icon before it. */
export function HobbyGroupLabel({ group }: { group: HobbyGroup }) {
  const { t } = useT();
  return (
    <View className="flex-row items-center gap-2">
      <Icon
        as={HOBBY_GROUP_ICONS[group]}
        size={16}
        className="text-muted-foreground"
        testID={`hobby-group-icon-${group}`}
      />
      <Text variant="muted" className="shrink">
        {t(`profile.hobbyGroup.${group}` as PlainMessageKey)}
      </Text>
    </View>
  );
}
