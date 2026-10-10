import { formatHeight, type PlainMessageKey } from "@kuutti/i18n";
import {
  HOBBY_GROUP_KEYS,
  HOBBY_GROUPS,
  PROFILE_FIELDS,
  type ProfileFieldKey,
  type ProfileFields,
  type ProfileUpdate,
} from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Stepper } from "@/components/ui/stepper";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { fieldLabelKey, optionKey } from "./keys";

/** Lists longer than this get a search box (#148): the languages, the hobbies, the lines of work. */
export const SEARCHABLE_FROM = 12;

type Draft = Pick<ProfileUpdate, "fields">;
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
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      variant={selected ? "default" : "outline"}
      accessibilityState={{ selected }}
      onPress={onPress}
    >
      {label}
    </Button>
  );
}

/**
 * The line above the article 9 fields (ADR-019 §4, #204): the consent was
 * given once, at the seeks step, and anyone active has it; here it is named,
 * with the one place it is withdrawn. No second switch.
 */
export function SpecialCategoryNote() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  return (
    <View className="gap-2">
      <Text variant="muted">{t("profile.specialCategory.note")}</Text>
      <Button
        variant="outline"
        accessibilityLabel={t("home.settings.open")}
        onPress={() => {
          tap();
          router.push("/settings");
        }}
      >
        {t("home.settings.open")}
      </Button>
    </View>
  );
}

/**
 * One field of the registry as the person answers it (#47, #148, ADR-019):
 * choices as chips, with a search box over a long list and the hobbies in
 * their groups; a number as a stepper; a short text; a setting as a switch.
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
        <Text variant="small" className="flex-1">
          {label}
        </Text>
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
        onPress={() => {
          tap();
          if (spec.kind === "multi") {
            const current = Array.isArray(value) ? (value as string[]) : [];
            const next = selected
              ? current.filter((v) => v !== option)
              : current.length < spec.max
                ? [...current, option]
                : current;
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
      <Text variant="small">{label}</Text>
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
          <Stepper
            label={label}
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
          <Text variant="muted">{t("profile.number.hint", { min: spec.min, max: spec.max })}</Text>
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
                    <Text variant="muted">
                      {t(`profile.hobbyGroup.${group}` as PlainMessageKey)}
                    </Text>
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
              {spec.options.filter(matches).map(chip)}
            </View>
          )}
        </>
      )}
    </View>
  );
}
