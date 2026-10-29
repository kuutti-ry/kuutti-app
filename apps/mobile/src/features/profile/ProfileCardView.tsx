import { formatHeight } from "@kuutti/i18n";
import {
  CARD_FIELD_KEYS,
  PROFILE_FIELDS,
  type ProfileCard,
  type ProfileFieldKey,
} from "@kuutti/schema";
import { useState } from "react";
import {
  type AccessibilityActionEvent,
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { captionKey, type OnRefused, PhotoDescriptionText, PhotoImage } from "@/features/media";
import { pondName } from "@/features/pond";
import { SafetyActions } from "@/features/safety";
import { useT } from "@/lib/locale";
import { usePhotoDescriptionText } from "@/lib/photo-descriptions";
import { cn } from "@/lib/utils";
import { DECORATIVE, TOUCH_TARGET } from "@/theme/a11y";
import { useHapticTap } from "@/theme/haptics";
import { FieldLabel } from "./fieldIcons";
import { hasGlyphs, OptionGlyph } from "./glyphs";
import { genderKey, optionKey, presetKey, promptKey } from "./keys";

/** The card's own accessibility action, by name; its label is the heard one. */
const SAFETY_ACTION = "blockOrReport";

/** A photo kept mounted but out of sight and hearing: back in front, it signs nothing again. */
const BEHIND = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
} as const;

/** Which photo of which card is in front, and the photos that card has shown so far. */
type Gallery = { card: string; index: number; seen: readonly string[] };

/**
 * A card as others see it (#47, #150): the photos in the card variant, one
 * at a time, the name and the age, the gender with the identity label
 * after it, then one answer in the person's own words (the sheet's Hinge
 * takeaway), the bio or its placeholder, the
 * info fields the API left on the card with what both answered marked in
 * words, and the rest of the prompts. The rounds of M4 render the same
 * component; the reason label of rules/mobile.md joins there.
 *
 * The photos are a gallery in the main photo's place (#513), as the big
 * dating apps have it: a tap on the right half shows the next, on the left
 * half the previous, with a bar per photo above them. The halves are two
 * named buttons, so a screen reader, a keyboard or a switch reaches them, and
 * the photo that comes is said. A photo is asked for when it first comes to
 * the front, never before (rules/mobile.md Images: prefetch counts as
 * exposure), and stays mounted behind, so going back signs nothing again:
 * at most one card-size URL per photo while the card is on the screen
 * (ADR-008, ADR-041 §1). The caption and the description under it follow
 * the photo in front.
 *
 * Someone else's card carries "Block or report" (#84, ADR-030 §11): an icon
 * button beside the name, and the same as an accessibility action on the
 * name. Only a screen that passes `onGone` shows it, so the owner's preview
 * never does. Its report may name one of the card's photos (#476), each
 * named as the card names it.
 */
export function ProfileCardView({
  card,
  onRefused,
  onGone,
}: {
  card: ProfileCard;
  /** A photo URL the API refused (#52 budget or another code): the screen says so instead of a silent placeholder. */
  onRefused?: OnRefused;
  /** Someone else's card: the person blocked or reported them, and the screen takes the card away. */
  onGone?: (accountId: string) => void;
}) {
  const { t, locale } = useT();
  const tap = useHapticTap();
  const [safetyOpen, setSafetyOpen] = useState(false);
  const described = usePhotoDescriptionText();
  const [firstPrompt, ...morePrompts] = card.prompts;
  const total = card.photos.length;
  const [gallery, setGallery] = useState<Gallery>({ card: card.accountId, index: 0, seen: [] });
  // Another person's card starts at their main photo, with nothing shown yet.
  const here = gallery.card === card.accountId ? gallery : { index: 0, seen: [] };
  const index = Math.min(here.index, Math.max(total - 1, 0));
  const front = card.photos[index];
  const seen = new Set([...here.seen, ...(front ? [front.id] : [])]);
  /** A photo's place on the card and the owner's line, as the report step shows it (#476). */
  const photoText = (photo: ProfileCard["photos"][number], position: number) =>
    photo.caption
      ? t("profile.card.photoLabelCaption", {
          position,
          total,
          caption: t(captionKey(photo.caption)),
        })
      : t("profile.card.photoLabel", { position, total });
  // A photo's label says its caption too (#296), so a screen reader hears the
  // owner's line with the picture, and then what the check saw in it.
  const photoLabel = (photo: ProfileCard["photos"][number], position: number) =>
    described.label(photoText(photo, position), photo.description);
  /** The description under a photo for the eye, where the setting asks for it. */
  const wordsUnder = (photo: ProfileCard["photos"][number]) =>
    described.shown ? described.describe(photo.description) : null;
  const frontWords = front ? wordsUnder(front) : null;
  /** The photo `step` away comes to the front, and a screen reader hears which it is. */
  const go = (step: -1 | 1) => {
    const next = card.photos[index + step];
    if (!next) return;
    tap();
    setGallery({ card: card.accountId, index: index + step, seen: [...seen, next.id] });
    AccessibilityInfo.announceForAccessibility(photoLabel(next, index + step + 1));
  };
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
      {front && (
        <View style={{ width: "100%", aspectRatio: 3 / 4 }}>
          {card.photos.map((photo, at) =>
            seen.has(photo.id) ? (
              <View
                key={photo.id}
                style={StyleSheet.absoluteFill}
                className={at === index ? undefined : "opacity-0"}
                pointerEvents="none"
                {...(at === index ? {} : BEHIND)}
              >
                <PhotoImage
                  id={photo.id}
                  variant="card"
                  blurhash={photo.blurhash}
                  accessibilityLabel={photoLabel(photo, at + 1)}
                  style={{ width: "100%", height: "100%" }}
                  onRefused={onRefused}
                />
              </View>
            ) : null,
          )}
          {total > 1 && (
            <>
              {/* Where in the photos the card is: the label says it in words. */}
              <View
                className="absolute inset-x-0 top-0 flex-row gap-1 p-2"
                pointerEvents="none"
                {...DECORATIVE}
              >
                {card.photos.map((photo, at) => (
                  <View
                    key={photo.id}
                    className={cn(
                      "h-1.5 flex-1 rounded-full border border-background",
                      at === index && "bg-background",
                    )}
                  />
                ))}
              </View>
              {(
                [
                  [-1, "profile.card.photoPrevious", "left-0"],
                  [1, "profile.card.photoNext", "right-0"],
                ] as const
              ).map(([step, label, side]) => {
                const none = !card.photos[index + step];
                return (
                  <Pressable
                    key={label}
                    accessibilityRole="button"
                    accessibilityLabel={t(label)}
                    accessibilityState={{ disabled: none }}
                    disabled={none}
                    className={cn("absolute inset-y-0 w-1/2", side)}
                    style={{ minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET }}
                    onPress={() => go(step)}
                  />
                );
              })}
            </>
          )}
        </View>
      )}
      <CardHeader>
        {front?.caption && <Caption text={t(captionKey(front.caption))} />}
        {frontWords && <PhotoDescriptionText text={frontWords} />}
        <View className="flex-row items-start gap-2">
          {/* The age in the title, as visible as the name: every account is bank-verified,
              so the card does not say so (#239). */}
          <CardTitle
            className="flex-1"
            {...(onGone && {
              // A screen reader reaches block or report from the name too.
              accessibilityActions: [{ name: SAFETY_ACTION, label: t("safety.actions.title") }],
              onAccessibilityAction: (event: AccessibilityActionEvent) => {
                if (event.nativeEvent.actionName === SAFETY_ACTION) setSafetyOpen(true);
              },
            })}
          >
            {t("profile.card.nameAge", { name: card.displayName, years: card.age.years })}
          </CardTitle>
          {onGone && (
            <SafetyActions
              accountId={card.accountId}
              // The report may name one of these (#476): named as here, in the variant
              // painted here, so the phone's cache has each the card showed and nothing
              // is signed again; one never shown is its blurhash.
              photos={card.photos.map((photo, at) => ({
                id: photo.id,
                variant: "card",
                blurhash: photo.blurhash,
                label: photoLabel(photo, at + 1),
                text: photoText(photo, at + 1),
              }))}
              open={safetyOpen}
              onOpenChange={setSafetyOpen}
              onGone={onGone}
            />
          )}
        </View>
        {card.gender && <Text variant="muted">{t(genderKey(card.gender))}</Text>}
        {identityLabel && (
          <Text variant="muted">{t(optionKey("identityLabel", identityLabel))}</Text>
        )}
        {card.pond && <Text variant="muted">{pondName(t, card.pond)}</Text>}
      </CardHeader>
      <CardContent className="gap-4">
        {firstPrompt && prompt(firstPrompt)}
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
