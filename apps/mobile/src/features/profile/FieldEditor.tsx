import { formatHeight, type PlainMessageKey } from "@kuutti/i18n";
import {
  CARD_FIELD_KEYS,
  HOBBY_GROUP_KEYS,
  HOBBY_GROUPS,
  PROFILE_FIELDS,
  type ProfileFieldKey,
  type ProfileFields,
  type ProfileUpdate,
} from "@kuutti/schema";
import Eye from "lucide-react-native/icons/eye";
import EyeOff from "lucide-react-native/icons/eye-off";
import type React from "react";
import { useState } from "react";
import { AccessibilityInfo, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Stepper } from "@/components/ui/stepper";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { FieldLabel, HobbyGroupLabel } from "./fieldIcons";
import { OptionGlyph, optionGlyph } from "./glyphs";
import { fieldLabelKey, optionKey } from "./keys";

/**
 * Lists of this many options or more get a search box (#148): the languages,
 * the hobbies, the lines of work. Not the thirteen star signs, the eleven
 * answers of politics or the twelve fields: they fit on a screen, and a box
 * over them was overkill (the maintainer, #239).
 */
export const SEARCHABLE_FROM = 14;

/**
 * The options a picker shows (#239): with something typed, every option whose
 * text matches; with nothing typed, all of them, or, on a list that names how
 * many lead it (the languages), those first ones, anything chosen already and
 * "other", the rest left to the search.
 */
export function visibleOptions(
  options: readonly string[],
  shownFirst: number | undefined,
  chosen: readonly string[],
  search: string,
  textOf: (option: string) => string,
): readonly string[] {
  const needle = search.trim().toLowerCase();
  if (needle !== "") return options.filter((o) => textOf(o).toLowerCase().includes(needle));
  if (shownFirst === undefined) return options;
  return options.filter((o, i) => i < shownFirst || chosen.includes(o) || o === "other");
}

/**
 * A multi-choice answer after a tap on one option (#239): a chosen option
 * goes; an option that stands alone ("none of them") replaces the rest; any
 * other joins, clearing an option that stands alone. No cap: a list takes as
 * many as one likes.
 */
export function toggled(
  current: readonly string[],
  option: string,
  spec: { alone: readonly string[] },
): string[] {
  if (current.includes(option)) return current.filter((o) => o !== option);
  if (spec.alone.includes(option)) return [option];
  return [...current.filter((o) => !spec.alone.includes(o)), option];
}

type Draft = Pick<ProfileUpdate, "fields" | "hiddenFields">;
type Update = (patch: Partial<Draft>) => void;

/**
 * The text of an option, adapted to another answer where the sheet says so
 * (#148): once there are kids, wanting them reads "want more", "no more",
 * "not sure anymore". The value stored is the same.
 */
export function optionTextKey(
  field: ProfileFieldKey,
  option: string,
  fields: ProfileFields,
): PlainMessageKey {
  if (field === "wantsKids" && fields.hasKids !== undefined && fields.hasKids !== "no") {
    return `profile.optionWithKids.wantsKids.${option}` as PlainMessageKey;
  }
  return optionKey(field, option);
}

/** One choice: a button that says whether it is chosen, never a colour alone. */
export function Chip({
  label,
  selected,
  onPress,
  glyph,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** A decorative glyph before the label (#213); the label still names the button. */
  glyph?: React.ReactNode;
}) {
  const variant = selected ? "default" : "outline";
  if (glyph === undefined || glyph === null || glyph === false) {
    return (
      <Button variant={variant} accessibilityState={{ selected }} onPress={onPress}>
        {label}
      </Button>
    );
  }
  return (
    <Button
      variant={variant}
      accessibilityState={{ selected }}
      onPress={onPress}
      accessibilityLabel={label}
    >
      <View className="flex-row items-center gap-2">
        {glyph}
        <Text>{label}</Text>
      </View>
    </Button>
  );
}

/**
 * What a field's title says about the card (#515). Everything a card can
 * carry shows until the person says otherwise, so the one thing to do here is
 * "Hide", and only once there is an answer: a long form stays a form, with no
 * row of switches to go through. A hidden answer says so, and says that
 * matching still reads it only where it does: nothing reads a height or a
 * religion. A soft field never reaches a card, by the service's decision
 * (ADR-019 §2), and says that instead, since it has no "Hide" to ask about.
 * The title's row keeps its height, so the first answer moves no chip from
 * under the finger.
 */
function FieldHeading({
  field,
  draft,
  update,
}: {
  field: ProfileFieldKey;
  draft: Draft;
  update: Update;
}) {
  const { t } = useT();
  const tap = useHapticTap();
  const onCards = (CARD_FIELD_KEYS as readonly ProfileFieldKey[]).includes(field);
  const answered = (draft.fields as Record<string, unknown>)[field] !== undefined;
  const hiddenFields = draft.hiddenFields ?? [];
  const chose = hiddenFields.includes(field);
  // Under "hide me from my field" the card leaves the field out whatever this says (#150).
  const bySetting = field === "field" && draft.fields.hideFromField === true;
  const hidden = answered && (chose || bySetting);
  const label = t(fieldLabelKey(field));
  const hiddenNote =
    PROFILE_FIELDS[field].preferenceAbout === "none"
      ? t("profile.hide.hidden")
      : t("profile.hide.hiddenMatching");
  const toggle = () => {
    tap();
    update({
      hiddenFields: chose ? hiddenFields.filter((key) => key !== field) : [...hiddenFields, field],
    });
    AccessibilityInfo.announceForAccessibility(chose ? t("profile.hide.shown") : hiddenNote);
  };

  if (!onCards) {
    return (
      <>
        <FieldLabel field={field} />
        <Text variant="muted">{t("profile.hide.never")}</Text>
      </>
    );
  }
  return (
    <>
      {/* A 44 pt row around a line of small text: the margins keep the title with its answers. */}
      <View className="-my-2 min-h-touch flex-row flex-wrap content-center items-center justify-between gap-x-3">
        <FieldLabel field={field} className="shrink" />
        {answered && !bySetting && (
          <Button
            variant="ghost"
            className="-mr-2 px-2"
            accessibilityLabel={t(chose ? "profile.hide.showLabel" : "profile.hide.actionLabel", {
              field: label,
            })}
            onPress={toggle}
          >
            <View className="flex-row items-center gap-1">
              <Icon as={chose ? Eye : EyeOff} size={16} />
              <Text className="text-sm font-medium">
                {t(chose ? "profile.hide.show" : "profile.hide.action")}
              </Text>
            </View>
          </Button>
        )}
      </View>
      {hidden && <Text variant="muted">{hiddenNote}</Text>}
    </>
  );
}

/**
 * One field of the registry as the person answers it (#47, #148, ADR-019):
 * choices as chips, with a search box over a long list, the first languages
 * before it and the hobbies in their groups; a number as a stepper; a short
 * text; a setting as a switch; with its title, what the card does with the
 * answer (FieldHeading).
 * Nothing here is particular to a field beyond the widget its kind asks for
 * and the one adaptive text of the sheet. The profile screen and the later
 * screens share it; the draft and its update are the caller's.
 */
export function FieldEditor({
  field,
  draft,
  update,
}: {
  field: ProfileFieldKey;
  draft: Draft;
  update: Update;
}) {
  const { t, locale } = useT();
  const tap = useHapticTap();
  const [search, setSearch] = useState("");
  const spec = PROFILE_FIELDS[field];
  const value = (draft.fields as Record<string, unknown>)[field];
  const chosen = Array.isArray(value) ? (value as string[]) : [];
  // An option once pressed stays in view while the editor is open, chosen or
  // not: taken back, a language beyond the first ten would vanish from under
  // the finger and the screen reader's focus, with no way to undo (#239).
  const [seen, setSeen] = useState<readonly string[]>([]);
  const label = t(fieldLabelKey(field));
  const setField = (next: unknown) => {
    const fields: Record<string, unknown> = { ...draft.fields };
    if (next === undefined) delete fields[field];
    else fields[field] = next;
    update({ fields: fields as ProfileFields });
  };

  if (spec.kind === "flag") {
    return (
      <View className="flex-row items-center justify-between gap-3">
        <FieldLabel field={field} className="flex-1" />
        <Switch
          accessibilityLabel={label}
          checked={value === true}
          onCheckedChange={(on) => {
            tap();
            setField(on ? true : undefined);
          }}
        />
      </View>
    );
  }

  const chip = (option: string) => {
    const selected =
      spec.kind === "multi" ? Array.isArray(value) && value.includes(option) : value === option;
    return (
      <Chip
        key={option}
        label={t(optionTextKey(field, option, draft.fields))}
        selected={selected}
        glyph={
          optionGlyph(field, option) && (
            <OptionGlyph
              field={field}
              option={option}
              className={selected ? "text-primary-foreground" : "text-foreground"}
            />
          )
        }
        onPress={() => {
          tap();
          if (spec.kind === "multi") {
            const next = toggled(chosen, option, spec);
            if (!seen.includes(option)) setSeen([...seen, option]);
            setField(next.length > 0 ? next : undefined);
          } else {
            setField(selected ? undefined : option);
          }
        }}
      />
    );
  };
  const matches = (option: string) =>
    search.trim() === "" ||
    t(optionTextKey(field, option, draft.fields))
      .toLowerCase()
      .includes(search.trim().toLowerCase());

  return (
    <View className="gap-2">
      <FieldHeading field={field} draft={draft} update={update} />
      {spec.kind === "text" && (
        <>
          <Input
            accessibilityLabel={label}
            value={typeof value === "string" ? value : ""}
            maxLength={spec.maxLength}
            onChangeText={(text) => setField(text.length > 0 ? text : undefined)}
          />
          <Text variant="muted">{t("profile.text.hint", { max: spec.maxLength })}</Text>
        </>
      )}
      {spec.kind === "number" && (
        <>
          {/* No label of its own: the FieldLabel above names it (#238). */}
          <Stepper
            value={typeof value === "number" ? value : Math.round((spec.min + spec.max) / 2)}
            shown={
              typeof value === "number" ? formatHeight(locale, value) : t("profile.number.unset")
            }
            downLabel={t("profile.number.down")}
            upLabel={t("profile.number.up")}
            canDown={typeof value !== "number" || value > spec.min}
            canUp={typeof value !== "number" || value < spec.max}
            onChange={(next) =>
              // The first press sets the middle of the range; every later one moves by one.
              setField(
                typeof value === "number"
                  ? Math.min(spec.max, Math.max(spec.min, next))
                  : Math.round((spec.min + spec.max) / 2),
              )
            }
          />
          {typeof value === "number" && (
            <Button
              variant="ghost"
              onPress={() => {
                tap();
                setField(undefined);
              }}
            >
              {t("profile.clear")}
            </Button>
          )}
        </>
      )}
      {(spec.kind === "single" || spec.kind === "multi") && (
        <>
          {spec.options.length >= SEARCHABLE_FROM && (
            <Input
              accessibilityLabel={t("profile.later.search")}
              placeholder={t("profile.later.search")}
              value={search}
              autoCapitalize="none"
              onChangeText={setSearch}
            />
          )}
          {field === "hobbies" ? (
            <View className="gap-3">
              {HOBBY_GROUP_KEYS.map((group) => {
                const options = HOBBY_GROUPS[group].filter(matches);
                if (options.length === 0) return null;
                return (
                  <View key={group} className="gap-1">
                    <HobbyGroupLabel group={group} />
                    <View className="flex-row flex-wrap gap-2">{options.map(chip)}</View>
                  </View>
                );
              })}
              {matches("other") && (
                <View className="flex-row flex-wrap gap-2">{chip("other")}</View>
              )}
            </View>
          ) : (
            <View className="flex-row flex-wrap gap-2">
              {visibleOptions(
                spec.options,
                spec.kind === "multi" ? spec.shownFirst : undefined,
                [...chosen, ...seen],
                search,
                (option) => t(optionTextKey(field, option, draft.fields)),
              ).map(chip)}
            </View>
          )}
        </>
      )}
    </View>
  );
}
