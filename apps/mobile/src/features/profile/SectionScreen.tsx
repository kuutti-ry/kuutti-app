import type { PlainMessageKey } from "@kuutti/i18n";
import {
  BIO_MAX,
  BIO_MIN_FOR_COMPLETENESS,
  BIO_PRESETS,
  DISPLAY_NAME_MAX,
  type ProfileUpdate,
  SPECIAL_CATEGORY_FIELDS,
} from "@kuutti/schema";
import { useNavigation, useRouter } from "expo-router";
import ArrowLeft from "lucide-react-native/icons/arrow-left";
import { Fragment, useEffect, useEffectEvent, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { currentSession } from "@/lib/session";
import { useHapticTap } from "@/theme/haptics";
import { Chip, FieldEditor, SpecialCategoryNote } from "./FieldEditor";
import { presetKey } from "./keys";
import { PromptsEditor } from "./PromptsEditor";
import { findSection, type SectionItem, sectionPath, sectionTitleKey } from "./sections";
import { type HeldDraft, type ProfileNotice, useProfile } from "./useProfile";

type Update = (patch: Partial<ProfileUpdate>) => void;

/** The API's refusals the screen has its own words for; anything else is the generic line. */
const ERROR_TEXT: ReadonlyMap<string, PlainMessageKey> = new Map([
  ["text_contact_details", "profile.error.text_contact_details"],
  ["consent_required", "errors.special_category_locked"],
]);

function errorText(notice: ProfileNotice, t: ReturnType<typeof useT>["t"]): string {
  const code = notice?.kind === "error" ? notice.code : undefined;
  return t(ERROR_TEXT.get(code ?? "") ?? "profile.error.generic");
}

function NameEditor({ draft, update }: { draft: ProfileUpdate; update: Update }) {
  const { t } = useT();
  return (
    <View className="gap-2">
      <Text variant="small">{t("profile.displayName.label")}</Text>
      <Input
        accessibilityLabel={t("profile.displayName.label")}
        value={draft.displayName}
        maxLength={DISPLAY_NAME_MAX}
        autoCapitalize="words"
        onChangeText={(displayName) => update({ displayName })}
      />
      <Text variant="muted">{t("profile.displayName.hint", { max: DISPLAY_NAME_MAX })}</Text>
    </View>
  );
}

function BioEditor({ draft, update }: { draft: ProfileUpdate; update: Update }) {
  const { t } = useT();
  const tap = useHapticTap();
  return (
    <View className="gap-2">
      <Text variant="small">{t("profile.bio.label")}</Text>
      <Input
        accessibilityLabel={t("profile.bio.label")}
        value={draft.bio ?? ""}
        maxLength={BIO_MAX}
        multiline
        // Room for four lines and more as the bio grows: a capped field scrolled
        // its start out of sight at large text sizes (10/10/2026).
        className="min-h-28"
        onChangeText={(text) =>
          update({
            bio: text.length > 0 ? text : null,
            bioPreset: text.length > 0 ? null : draft.bioPreset,
          })
        }
      />
      <Text variant="muted">{t("profile.bio.hint", { min: BIO_MIN_FOR_COMPLETENESS })}</Text>
      <Text variant="small">{t("profile.bio.orPreset")}</Text>
      <View className="flex-row flex-wrap gap-2">
        {BIO_PRESETS.map((preset) => (
          <Chip
            key={preset}
            label={t(presetKey(preset))}
            selected={draft.bioPreset === preset}
            onPress={() => {
              tap();
              update(
                draft.bioPreset === preset ? { bioPreset: null } : { bioPreset: preset, bio: null },
              );
            }}
          />
        ))}
      </View>
    </View>
  );
}

function ItemEditor({
  item,
  draft,
  update,
}: {
  item: SectionItem;
  draft: ProfileUpdate;
  update: Update;
}) {
  if (item === "displayName") return <NameEditor draft={draft} update={update} />;
  if (item === "bio") return <BioEditor draft={draft} update={update} />;
  if (item === "prompts") return <PromptsEditor draft={draft} update={update} />;
  // The identity label is offered after a non-binary gender only, in
  // onboarding (the registry's rule, #146); here it shows when it was
  // given, to change or clear it, and is not offered to everyone.
  if (item === "identityLabel" && draft.fields.identityLabel === undefined) return null;
  return <FieldEditor field={item} draft={draft} update={update} />;
}

/** Drafts the API refused after their section had gone, by section (#238). */
// shortcut: a refused section comes back on top of whatever is open; had the
// person already edited another section there, both save the whole document
// and the one left last wins. Only after a refusal slower than opening and
// editing another section; a save of the changed fields alone would lift it.
const refusedDrafts = new Map<string, HeldDraft>();

/**
 * One section of the profile (#227): its editors only, and no Save button.
 * Leaving (the back button, the swipe, Android's back key) saves the whole
 * document once when something changed. The leaving is never held up: held,
 * the native swipe on iOS popped the screen, put it back and popped it again
 * (#238). So the save goes as the screen goes, and a refusal brings the
 * section back with the draft and the reason, and asks before leaving without
 * saving. Not a save per tap: each save is a `profile_saved` research event
 * (ADR-011), and a refused bio is best said on the screen that holds it.
 */
export function SectionScreen({ section: id }: { section: string }) {
  const { t } = useT();
  const router = useRouter();
  const navigation = useNavigation();
  const tap = useHapticTap();
  // Read once: a section opened again for a refused draft takes it up.
  const [held] = useState(() => refusedDrafts.get(id));
  useEffect(() => {
    refusedDrafts.delete(id);
  }, [id]);
  const profile = useProfile(held);
  const { draft, update } = profile;
  const section = findSection(id);
  // Anything that is not a section goes to the list: a typed address, an old link.
  useEffect(() => {
    if (!section) router.replace("/profile");
  }, [section, router]);

  const [asking, setAsking] = useState(held !== undefined);
  // Once per screen: saved on the way out, or let go unsaved on the word.
  const left = useRef(false);
  const onLeave = useEffectEvent(() => {
    if (left.current || !section || !profile.dirty) return;
    left.current = true;
    void profile.save().then((notice) => {
      // A session that ended has taken the person to the sign-in, and the draft with it.
      if (!notice || !currentSession()) return;
      refusedDrafts.set(id, { draft, notice });
      router.push(sectionPath(section.id));
    });
  });
  useEffect(() => navigation.addListener("beforeRemove", () => onLeave()), [navigation]);

  if (!section) return null;
  const firstSpecial = section.items.find((item) =>
    (SPECIAL_CATEGORY_FIELDS as readonly string[]).includes(item),
  );

  if (profile.status === "loading") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center p-6">
          <Text accessibilityLiveRegion="polite">{t("profile.loading")}</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (profile.status === "error") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-4 p-6">
          <Text accessibilityLiveRegion="assertive">{t("profile.failed")}</Text>
          <Button onPress={() => void profile.reload()}>{t("profile.retry")}</Button>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView
        contentContainerClassName="flex-grow gap-6 p-6"
        keyboardShouldPersistTaps="handled"
      >
        <View className="flex-row items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            accessibilityLabel={t("profile.section.back")}
            onPress={() => {
              tap();
              router.back();
            }}
          >
            <Icon as={ArrowLeft} />
          </Button>
          <Text variant="h1" accessibilityRole="header" className="flex-1">
            {t(sectionTitleKey(section.id))}
          </Text>
        </View>
        {profile.notice?.kind === "error" && (
          <Text accessibilityLiveRegion="assertive">{errorText(profile.notice, t)}</Text>
        )}

        {section.items.map((item) => (
          <Fragment key={item}>
            {/* The article 9 fields stand under the note on their consent (ADR-019 §4, #204):
                anyone active gave it at the seeks step; Settings is where it is withdrawn. */}
            {item === firstSpecial && <SpecialCategoryNote />}
            <ItemEditor item={item} draft={draft} update={update} />
          </Fragment>
        ))}
      </ScrollView>

      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent closeLabel={t("profile.discard.close")}>
          <DialogHeader>
            <DialogTitle>{t("profile.discard.title")}</DialogTitle>
            <DialogDescription>{errorText(profile.notice, t)}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onPress={() => setAsking(false)}>
              {t("profile.discard.keep")}
            </Button>
            <Button
              variant="destructive"
              onPress={() => {
                left.current = true;
                setAsking(false);
                router.back();
              }}
            >
              {t("profile.discard.leave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SafeAreaView>
  );
}
