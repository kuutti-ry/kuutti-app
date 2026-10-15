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
import { captionKey, type OnRefused, PhotoImage } from "@/features/media";
import { pondName } from "@/features/pond";
import { useT } from "@/lib/locale";
import { FieldLabel } from "./fieldIcons";
import { hasGlyphs, OptionGlyph } from "./glyphs";
import { genderKey, optionKey, presetKey, promptKey } from "./keys";

/**
 * A card as others see it (#47, #150): the main photo in the card variant,
 * the name and the age, the gender with the identity label
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
  // A photo's label says its caption too (#296), so a screen reader hears the owner's line with the picture.
  const photoLabel = (photo: ProfileCard["photos"][number], position: number) =>
    photo.caption
      ? t("profile.card.photoLabelCaption", {
          position,
          total,
          caption: t(captionKey(photo.caption)),
        })
      : t("profile.card.photoLabel", { position, total });
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
          accessibilityLabel={photoLabel(main, 1)}
          style={{ width: "100%", aspectRatio: 3 / 4 }}
          onRefused={onRefused}
        />
      )}
      <CardHeader>
        {main?.caption && <Caption text={t(captionKey(main.caption))} />}
        {/* The age in the title, as visible as the name: every account is bank-verified,
            so the card does not say so (#239). */}
        <CardTitle>
          {t("profile.card.nameAge", { name: card.displayName, years: card.age.years })}
        </CardTitle>
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
              <View key={photo.id} className="w-24 gap-1">
                <PhotoImage
                  id={photo.id}
                  variant="thumb"
                  blurhash={photo.blurhash}
                  accessibilityLabel={photoLabel(photo, index + 2)}
                  style={{ width: 96, height: 96, borderRadius: 8 }}
                  onRefused={onRefused}
                />
                {photo.caption && <Caption text={t(captionKey(photo.caption))} />}
              </View>
            ))}
          </View>
        )}
        {card.bio && <Text>{card.bio}</Text>}
        {!card.bio && card.bioPreset && <Text>{t(presetKey(card.bioPreset))}</Text>}
        {CARD_FIELD_KEYS.map((key) => {
          const value = fields[key];
          // The identity label stands in the header, after the gender.
          if (value === undefined || key === "identityLabel") return null;
          if (hasGlyphs(key)) {
            // A party, a religion, a star sign: the glyph before each name (#213).
            const options = (Array.isArray(value) ? value : [value]).map(String);
            return (
              <View key={key} className="gap-0.5">
                <FieldLabel field={key} />
                <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
                  {options.map((option) => (
                    <View key={option} className="flex-row items-center gap-1">
                      <OptionGlyph field={key} option={option} />
                      <Text>{t(optionKey(key, option))}</Text>
                    </View>
                  ))}
                </View>
              </View>
            );
          }
          const shown = shownOf(key, value);
          if (shown === null) return null;
          return (
            <View key={key} className="gap-0.5">
              <FieldLabel field={key} />
              <Text>{shown}</Text>
            </View>
          );
        })}
        {morePrompts.map(prompt)}
      </CardContent>
    </Card>
  );
}

/**
 * The owner's line under a photo (#296), for the eye. The photo's own label
 * already says it to a screen reader, so the text is not an element of its
 * own there: the line is heard once, with the picture.
 */
function Caption({ text }: { text: string }) {
  return (
    <Text
      variant="small"
      className="text-muted-foreground"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {text}
    </Text>
  );
}
