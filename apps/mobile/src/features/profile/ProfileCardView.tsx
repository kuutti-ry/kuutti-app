import { formatHeight } from "@kuutti/i18n";
import {
  CARD_FIELD_KEYS,
  PROFILE_FIELDS,
  type ProfileCard,
  type ProfileFieldKey,
} from "@kuutti/schema";
import { View } from "react-native";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { type OnRefused, PhotoImage } from "@/features/media";
import { pondName } from "@/features/pond";
import { useT } from "@/lib/locale";
import { fieldLabelKey, genderKey, optionKey, presetKey, promptKey } from "./keys";

/**
 * A card as others see it (#47, #150): the main photo in the card variant,
 * the name and the bank-verified age, the gender with the identity label
 * after it, then one answer in the person's own words (the sheet's Hinge
 * takeaway), the other photos as thumbs, the bio or its placeholder, the
 * info fields the API left on the card with what both answered marked in
 * words, and the rest of the prompts. The rounds of M4 render the same
 * component; the reason label of rules/mobile.md joins there.
 */
export function ProfileCardView({
  card,
  onRefused,
}: {
  card: ProfileCard;
  /** A photo URL the API refused (#52 budget or another code): the screen says so instead of a silent placeholder. */
  onRefused?: OnRefused;
}) {
  const { t, locale } = useT();
  const [main, ...rest] = card.photos;
  const [firstPrompt, ...morePrompts] = card.prompts;
  const total = card.photos.length;
  const fields = card.fields as Record<string, unknown>;
  const identityLabel = typeof fields.identityLabel === "string" ? fields.identityLabel : null;

  /** A field's value in words; null for what the card never shows (a setting). */
  const shownOf = (key: ProfileFieldKey, value: unknown): string | null => {
    const spec = PROFILE_FIELDS[key];
    if (spec.kind === "flag") return null;
    if (spec.kind === "text") return String(value);
    if (spec.kind === "number") return formatHeight(locale, Number(value));
    const shared: readonly string[] =
      key === "hobbies" ? card.shared.hobbies : key === "languages" ? card.shared.languages : [];
    return (Array.isArray(value) ? value : [value])
      .map((option) => {
        const text = t(optionKey(key, String(option)));
        // What both answered is said, never a colour alone (CLAUDE.md Accessibility).
        return shared.includes(String(option))
          ? t("profile.card.sharedOption", { option: text })
          : text;
      })
      .join(", ");
  };
  const prompt = (answer: ProfileCard["prompts"][number]) => (
    <View key={answer.key} className="gap-0.5">
      <Text variant="small">{t(promptKey(answer.key))}</Text>
      <Text>{answer.answer}</Text>
    </View>
  );

  return (
    <Card>
      {main && (
        <PhotoImage
          id={main.id}
          variant="card"
          blurhash={main.blurhash}
          accessibilityLabel={t("profile.card.photoLabel", { position: 1, total })}
          style={{ width: "100%", aspectRatio: 3 / 4 }}
          onRefused={onRefused}
        />
      )}
      <CardHeader>
        <CardTitle>{card.displayName}</CardTitle>
        <Text variant="muted">{t("profile.card.verifiedAge", { years: card.age.years })}</Text>
        {card.gender && <Text variant="muted">{t(genderKey(card.gender))}</Text>}
        {identityLabel && (
          <Text variant="muted">{t(optionKey("identityLabel", identityLabel))}</Text>
        )}
        {card.pond && <Text variant="muted">{pondName(t, card.pond)}</Text>}
      </CardHeader>
      <CardContent className="gap-4">
        {firstPrompt && prompt(firstPrompt)}
        {rest.length > 0 && (
          <View className="flex-row flex-wrap gap-2">
            {rest.map((photo, index) => (
              <PhotoImage
                key={photo.id}
                id={photo.id}
                variant="thumb"
                blurhash={photo.blurhash}
                accessibilityLabel={t("profile.card.photoLabel", { position: index + 2, total })}
                style={{ width: 96, height: 96, borderRadius: 8 }}
                onRefused={onRefused}
              />
            ))}
          </View>
        )}
        {card.bio && <Text>{card.bio}</Text>}
        {!card.bio && card.bioPreset && <Text>{t(presetKey(card.bioPreset))}</Text>}
        {CARD_FIELD_KEYS.map((key) => {
          const value = fields[key];
          // The identity label stands in the header, after the gender.
          if (value === undefined || key === "identityLabel") return null;
          const shown = shownOf(key, value);
          if (shown === null) return null;
          return (
            <View key={key} className="gap-0.5">
              <Text variant="small">{t(fieldLabelKey(key))}</Text>
              <Text>{shown}</Text>
            </View>
          );
        })}
        {morePrompts.map(prompt)}
      </CardContent>
    </Card>
  );
}
