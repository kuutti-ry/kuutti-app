import { CARD_FIELD_KEYS, PROFILE_FIELDS, type ProfileCard } from "@kuutti/schema";
import { View } from "react-native";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { type OnRefused, PhotoImage } from "@/features/media";
import { useT } from "@/lib/locale";
import { fieldLabelKey, optionKey, presetKey, promptKey } from "./keys";

/**
 * A card as others see it (#47): the main photo in the card variant, the
 * name and the bank-verified age, the other photos as thumbs, the choices,
 * the bio or its placeholder, the prompts. The rounds of M4 render the same
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
  const { t } = useT();
  const [main, ...rest] = card.photos;
  const total = card.photos.length;
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
        {card.pond && <Text variant="muted">{card.pond.name}</Text>}
      </CardHeader>
      <CardContent className="gap-4">
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
          const value = (card.fields as Record<string, unknown>)[key];
          if (value === undefined) return null;
          const spec = PROFILE_FIELDS[key];
          // The card fields only (ADR-019 §2): a setting never comes this far, and the
          // height is the one number, shown with its unit.
          if (spec.kind === "flag") return null;
          const shown =
            spec.kind === "text"
              ? String(value)
              : spec.kind === "number"
                ? t("profile.field.height.value", { cm: Number(value) })
                : (Array.isArray(value) ? value : [value])
                    .map((option) => t(optionKey(key, String(option))))
                    .join(", ");
          return (
            <View key={key} className="gap-0.5">
              <Text variant="small">{t(fieldLabelKey(key))}</Text>
              <Text>{shown}</Text>
            </View>
          );
        })}
        {card.prompts.map((prompt) => (
          <View key={prompt.key} className="gap-0.5">
            <Text variant="small">{t(promptKey(prompt.key))}</Text>
            <Text>{prompt.answer}</Text>
          </View>
        ))}
      </CardContent>
    </Card>
  );
}
