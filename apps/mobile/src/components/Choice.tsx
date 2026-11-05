import { Button } from "@/components/ui/button";
import { useT } from "@/lib/locale";

/**
 * One option of a group. The chosen one is marked in text too, never by colour
 * alone. A flag, when given, is decoration in front of the text: the accessible
 * name is the text alone, so a screen reader never announces "flag: Åland".
 * In a column it takes the whole width and wraps, as a screen that asks one
 * thing lists its options (#581); in a wrapping row it shares out what the
 * line leaves.
 */
export function Choice(props: {
  label: string;
  /** What a screen reader says in its place, where the label is marks rather than words. */
  spoken?: string;
  flag?: string;
  chosen: boolean;
  /** One of several that can stand together, so a checkbox to a screen reader: a radio says the others go. */
  several?: boolean;
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
      accessibilityRole={props.several ? "checkbox" : "radio"}
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
