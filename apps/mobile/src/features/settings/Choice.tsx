import type { PlainMessageKey } from "@kuutti/i18n";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/locale";
import type { SchemePreference } from "@/theme/ThemeProvider";

export const SCHEMES: ReadonlyArray<{ value: SchemePreference; label: PlainMessageKey }> = [
  { value: "system", label: "settings.theme.system" },
  { value: "light", label: "settings.theme.light" },
  { value: "dark", label: "settings.theme.dark" },
];

/**
 * One option of a group. The chosen one is marked in text too, never by colour
 * alone. A flag, when given, is decoration in front of the text: the accessible
 * name is the text alone, so a screen reader never announces "flag: Åland".
 */
export function Choice(props: {
  label: string;
  /** What a screen reader says in its place, where the label is marks rather than words. */
  spoken?: string;
  flag?: string;
  chosen: boolean;
  /** Not pressable for now, as while the group's answer is on its way. */
  disabled?: boolean;
  onPress: () => void;
}) {
  const { t } = useT();
  const marked = (option: string) => (props.chosen ? t("settings.selected", { option }) : option);
  const name = marked(props.label);
  return (
    <Button
      variant={props.chosen ? "default" : "outline"}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.chosen }}
      // react-native-web reads the ARIA prop, not accessibilityState.
      aria-checked={props.chosen}
      accessibilityLabel={marked(props.spoken ?? props.label)}
      className="grow"
      disabled={props.disabled}
      onPress={props.onPress}
    >
      {props.flag ? `${props.flag} ${name}` : name}
    </Button>
  );
}
