import { formatHeight } from "@kuutti/i18n";
import {
  CARD_FIELD_KEYS,
  DEAL_BREAKER_FIELDS,
  type DistanceBand,
  HOBBY_GROUPS,
  type HobbyGroup,
  PROFILE_FIELDS,
  type ProfileCard,
  type ProfileFieldKey,
} from "@kuutti/schema";
import ChevronDown from "lucide-react-native/icons/chevron-down";
import ChevronUp from "lucide-react-native/icons/chevron-up";
import { Fragment, useState } from "react";
import {
  type AccessibilityActionEvent,
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Text, TextClassContext } from "@/components/ui/text";
import { captionKey, type OnRefused, PhotoDescriptionText, PhotoImage } from "@/features/media";
import { SafetyActions } from "@/features/safety";
import { useT } from "@/lib/locale";
import { usePhotoDescriptionText } from "@/lib/photo-descriptions";
import { cn } from "@/lib/utils";
import { DECORATIVE, TOUCH_TARGET } from "@/theme/a11y";
import { useHapticTap } from "@/theme/haptics";
import { FIELD_ICONS, HOBBY_GROUP_ICONS } from "./fieldIcons";
import { OptionGlyph, optionGlyph } from "./glyphs";
import { fieldLabelKey, genderKey, optionKey, placeName, presetKey, promptKey } from "./keys";
import { PROFILE_SECTIONS, type SectionItem, sectionTitleKey } from "./sections";

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
 * The answers the short card shows (#644, the maintainer's of 07/11/2026):
 * what the person is here for and the six a deal-breaker can be set on,
 * the answers people care enough about to filter on, in the registry's order.
 */
const KEY_FACTS: readonly ProfileFieldKey[] = CARD_FIELD_KEYS.filter(
  (key) => key === "intent" || DEAL_BREAKER_FIELDS.includes(key),
);

const isCardField = (item: SectionItem): item is ProfileFieldKey =>
  (CARD_FIELD_KEYS as readonly string[]).includes(item);

/**
 * The rest of a card's answers, on the whole card, under the profile's own
 * sections and in their order (#644), the one the person fills them in: the
 * key facts stand above, and the identity label in the header.
 */
const WHOLE_SECTIONS = PROFILE_SECTIONS.map((section) => ({
  id: section.id,
  fields: (section.items as readonly SectionItem[])
    .filter(isCardField)
    .filter((key) => !KEY_FACTS.includes(key) && key !== "identityLabel"),
})).filter((section) => section.fields.length > 0);

/** Each hobby's group, whose icon stands before the hobby on its chip. */
const HOBBY_GROUP_OF: ReadonlyMap<string, HobbyGroup> = new Map(
  (Object.entries(HOBBY_GROUPS) as [HobbyGroup, readonly string[]][]).flatMap(([group, hobbies]) =>
    hobbies.map((hobby) => [hobby, group] as const),
  ),
);

/**
 * One answer as a chip (#644): the person's own words, as the field's own
 * screen offered them, and how a screen reader hears it, which the icon
 * before the words cannot say.
 */
type Chip = {
  id: string;
  field: ProfileFieldKey;
  option: string | null;
  text: string;
  /** Both the viewer and the subject answered it (#150): filled and in bold, never a colour alone. */
  shared: boolean;
  /** A field that reads as the work beside it says both answers, with both icons. */
  withWork: boolean;
  heard: string;
};
type Unheard = Omit<Chip, "heard">;

/**
 * A field and a work that read the same are one chip with both icons (#644,
 * the maintainer's of 07/11/2026): two chips of "Arts and culture" told the
 * two answers apart by their icons alone. Matched by the words the reader
 * sees, so a pair that differs in a language stays two there. The fields come
 * before the work in their section, so the work's chip is taken as its field's
 * twin is reached.
 */
function mergeFieldAndWork(chips: readonly Unheard[]): Unheard[] {
  const taken = new Set<string>();
  return chips.flatMap((chip) => {
    if (taken.has(chip.id)) return [];
    if (chip.field !== "field") return [chip];
    const work = chips.find(
      (other) => other.field === "occupation" && other.text === chip.text && !taken.has(other.id),
    );
    if (!work) return [chip];
    taken.add(work.id);
    return [{ ...chip, withWork: true }];
  });
}

/**
 * A card as others see it (#47, #150), in two depths (#644, the maintainer's
 * of 07/11/2026). The short card: the name with the age, then the gender
 * with the identity label after it, the name of the home and, in a round, how
 * far it is in words (ADR-061 §3, §5), on one line with no digits, no
 * kilometres and no meaning in a colour; the photos; the key facts as chips;
 * one answer in the person's own words, the first prompt or the bio when
 * there is none (the field sheet's Hinge takeaway, ADR-009 §7); and "Show the
 * whole card" while there is more. The whole card opens in place under it:
 * the bio, the other prompts and the rest of the answers under the profile's
 * own section titles. A new card starts short, as it starts at its main photo.
 *
 * A chip is an answer in the person's own words with the field's icon before
 * it, or the option's own glyph (#213), Hinge's way ("<cigarette> Never"),
 * the maintainer's call: the icon is decorative, so a field's first chip is
 * heard with its question ("Smoking: Never"). An answer both people gave is
 * filled and in bold, heard as shared, never a count or a score (ADR-009 §7);
 * the words "you too" went for reading like "me too".
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
  distance,
  onRefused,
  onGone,
}: {
  card: ProfileCard;
  /** How far the person lives, as their round entry froze it (ADR-061 §5); a card outside a round has none. */
  distance?: DistanceBand | null;
  /** A photo URL the API refused (#52 budget or another code): the screen says so instead of a silent placeholder. */
  onRefused?: OnRefused;
  /** Someone else's card: the person blocked or reported them, and the screen takes the card away. */
  onGone?: (accountId: string) => void;
}) {
  const { t, locale } = useT();
  const tap = useHapticTap();
  const [safetyOpen, setSafetyOpen] = useState(false);
  /** The person whose whole card is open: another person's card starts short. */
  const [opened, setOpened] = useState<string | null>(null);
  const whole = opened === card.accountId;
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
  /** The header's one line (#644): each word its own text, heard on its own. */
  const line = [
    card.gender ? t(genderKey(card.gender)) : null,
    identityLabel ? t(optionKey("identityLabel", identityLabel)) : null,
    card.place ? placeName(card.place, locale) : null,
    distance ? t(optionKey("distance", distance)) : null,
  ].filter((word): word is string => word !== null);

  /** A field's answers as chips, one an option; none for what the card never shows (a setting). */
  const chipsOf = (key: ProfileFieldKey): Unheard[] => {
    const value = fields[key];
    const spec = PROFILE_FIELDS[key];
    if (value === undefined || spec.kind === "flag") return [];
    const answers: { option: string | null; text: string }[] =
      spec.kind === "text"
        ? [{ option: null, text: String(value) }]
        : spec.kind === "number"
          ? [{ option: null, text: formatHeight(locale, Number(value)) }]
          : (Array.isArray(value) ? value : [value]).map((option) => ({
              option: String(option),
              text: t(optionKey(key, String(option))),
            }));
    const shared: readonly string[] =
      key === "hobbies" ? card.shared.hobbies : key === "languages" ? card.shared.languages : [];
    return answers.map((answer) => ({
      ...answer,
      id: `${key}.${answer.option ?? "value"}`,
      field: key,
      shared: answer.option !== null && shared.includes(answer.option),
      withWork: false,
    }));
  };
  /**
   * How each chip is heard: a field's first chip of its own names its question,
   * which the icon says only to the eye, and a field read as the work names both.
   */
  const heardAll = (chips: readonly Unheard[]): Chip[] => {
    const asked = new Set<ProfileFieldKey>();
    return chips.map((chip) => {
      const answer = chip.shared ? t("profile.card.shared", { option: chip.text }) : chip.text;
      if (chip.withWork) return { ...chip, heard: t("profile.card.fieldAndWork", { answer }) };
      const first = !asked.has(chip.field);
      asked.add(chip.field);
      return {
        ...chip,
        heard: first
          ? t("profile.card.fact", { question: t(fieldLabelKey(chip.field)), answer })
          : answer,
      };
    });
  };
  const keyChips = heardAll(KEY_FACTS.flatMap(chipsOf));
  const sections = WHOLE_SECTIONS.map((section) => ({
    id: section.id,
    chips: heardAll(mergeFieldAndWork(section.fields.flatMap(chipsOf))),
  })).filter((section) => section.chips.length > 0);
  // What the person wrote wins over a ready line, an empty bio being none.
  const bio = card.bio || (card.bioPreset ? t(presetKey(card.bioPreset)) : null);
  const prompt = (answer: ProfileCard["prompts"][number]) => (
    <View key={answer.key} className="gap-0.5">
      <Text variant="small">{t(promptKey(answer.key))}</Text>
      <Text>{answer.answer}</Text>
    </View>
  );
  // With no prompt, the bio is the short card's words and the whole card has none left.
  const moreWords = firstPrompt
    ? [...(bio ? [<Text key="bio">{bio}</Text>] : []), ...morePrompts.map(prompt)]
    : [];
  const more = moreWords.length > 0 || sections.length > 0;
  const content = keyChips.length > 0 || firstPrompt !== undefined || bio !== null || more;
  const toggleText = t(whole ? "profile.card.showLess" : "profile.card.showWhole");

  return (
    <Card>
      <CardHeader>
        {/* The name and the line under it in one column, Block or report beside both,
            so its 44 pt target puts no gap between them (#644). */}
        <View className="flex-row items-start gap-2">
          <View className="flex-1 gap-1.5">
            {/* The age in the title, as visible as the name: every account is bank-verified,
                so the card does not say so (#239). */}
            <CardTitle
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
            {line.length > 0 && <HeaderLine words={line} />}
          </View>
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
      </CardHeader>
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
      {(front?.caption || frontWords) && (
        <View className="gap-1.5 px-6">
          {front?.caption ? <Caption text={t(captionKey(front.caption))} /> : null}
          {frontWords ? <PhotoDescriptionText text={frontWords} /> : null}
        </View>
      )}
      {content && (
        <CardContent className="gap-4">
          {keyChips.length > 0 && <Chips chips={keyChips} />}
          {firstPrompt ? prompt(firstPrompt) : bio ? <Text>{bio}</Text> : null}
          {more && (
            <Button
              variant="outline"
              accessibilityLabel={toggleText}
              accessibilityState={{ expanded: whole }}
              onPress={() => {
                tap();
                setOpened(whole ? null : card.accountId);
              }}
            >
              <Text>{toggleText}</Text>
              <Icon as={whole ? ChevronUp : ChevronDown} size={18} />
            </Button>
          )}
          {whole && moreWords}
          {whole &&
            sections.map((section) => (
              <View key={section.id} className="gap-2">
                <Text variant="small" role="heading">
                  {t(sectionTitleKey(section.id))}
                </Text>
                <Chips chips={section.chips} />
              </View>
            ))}
        </CardContent>
      )}
    </Card>
  );
}

/**
 * The header's words on one line (#644), apart by a drawn dot that is no
 * text: the gender, the identity label, the home, the band. Each stays a
 * text of its own and no sentence is built around the place's name (TD-17).
 */
function HeaderLine({ words }: { words: readonly string[] }) {
  return (
    <View testID="card-line" className="flex-row flex-wrap items-center gap-x-2">
      {words.map((word, at) => (
        <Fragment key={word}>
          {at > 0 && (
            <View
              testID="card-line-dot"
              className="h-1 w-1 rounded-full bg-muted-foreground"
              {...DECORATIVE}
            />
          )}
          <Text variant="muted">{word}</Text>
        </Fragment>
      ))}
    </View>
  );
}

/** Chips that wrap onto as many lines as they need, never a sideways scroll (#644). */
function Chips({ chips }: { chips: readonly Chip[] }) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {chips.map((chip) => (
        <FactChip key={chip.id} chip={chip} />
      ))}
    </View>
  );
}

/**
 * One answer: the option's glyph where it has one (#213), a hobby's group
 * icon, else the field's, then the words. A shared answer is filled and in
 * bold, so the meaning never rests on the colour (CLAUDE.md Accessibility),
 * and the chip is heard as one element.
 */
function FactChip({ chip }: { chip: Chip }) {
  const group =
    chip.field === "hobbies" && chip.option ? HOBBY_GROUP_OF.get(chip.option) : undefined;
  const inner = (
    <>
      {chip.option !== null && optionGlyph(chip.field, chip.option) !== null ? (
        // Only hobbies and languages are ever shared, and neither has a glyph.
        <OptionGlyph field={chip.field} option={chip.option} className="h-4 w-4 text-foreground" />
      ) : (
        <Icon
          as={group ? HOBBY_GROUP_ICONS[group] : FIELD_ICONS[chip.field]}
          size={16}
          testID={group ? `hobby-group-icon-${group}` : `field-icon-${chip.field}`}
        />
      )}
      {chip.withWork && (
        <Icon as={FIELD_ICONS.occupation} size={16} testID="field-icon-occupation" />
      )}
      <Text className="shrink">{chip.text}</Text>
    </>
  );
  return (
    <View
      accessible
      accessibilityLabel={chip.heard}
      testID={`chip-${chip.id}`}
      className={cn(
        "max-w-full flex-row items-center gap-1.5 rounded-full border px-3 py-1",
        // The outline stays on a shared chip: the high-contrast sets' fill is their
        // background, and there the bold alone tells it, still a chip.
        "border-border",
        chip.shared && "bg-secondary",
      )}
    >
      {chip.shared ? (
        <TextClassContext.Provider value="font-semibold text-secondary-foreground">
          {inner}
        </TextClassContext.Provider>
      ) : (
        inner
      )}
    </View>
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
