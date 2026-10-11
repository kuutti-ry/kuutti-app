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
// Expo Router 57 vendors React Navigation and exposes the hook that holds a
// native stack's swipe-back only from the vendored core: a plain beforeRemove
// listener cannot stop a native removal (the screen leaves the stack natively
// while JS keeps it; 09/10/2026, the simulator).
import { usePreventRemove } from "expo-router/build/react-navigation/core";
import ArrowLeft from "lucide-react-native/icons/arrow-left";
import { Fragment, useEffect, useRef, useState } from "react";
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
import { useHapticTap } from "@/theme/haptics";
import { Chip, FieldEditor, SpecialCategoryNote } from "./FieldEditor";
import { presetKey } from "./keys";
import { PromptsEditor } from "./PromptsEditor";
import { findSection, type SectionItem, sectionTitleKey } from "./sections";
import { type ProfileNotice, useProfile } from "./useProfile";

type LeaveAction = Parameters<Parameters<typeof usePreventRemove>[1]>[0]["data"]["action"];
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

/**
 * One section of the profile (#227): its editors only, and no Save button.
 * Leaving (the back button, the swipe, Android's back key) saves the whole
 * document once when something changed, then goes; a refusal keeps the
 * screen, says why, and offers to stay or to leave without saving. Not a save
 * per tap: each save is a `profile_saved` research event (ADR-011), and a
 * refused bio is best said on the screen that holds it.
 */
export function SectionScreen({ section: id }: { section: string }) {
  const { t } = useT();
  const router = useRouter();
  const navigation = useNavigation();
  const tap = useHapticTap();
  const profile = useProfile();
  const { draft, update } = profile;
  const section = findSection(id);
  // Anything that is not a section goes to the list: a typed address, an old link.
  useEffect(() => {
    if (!section) router.replace("/profile");
  }, [section, router]);

  const [refused, setRefused] = useState<LeaveAction | null>(null);
  const leaving = useRef(false);
  // The action handed back remembers it was held here, so dispatching it leaves.
  usePreventRemove(profile.dirty, ({ data }) => {
    if (leaving.current) return;
    leaving.current = true;
    void profile.save().then((saved) => {
      leaving.current = false;
      if (saved) navigation.dispatch(data.action);
      else setRefused(data.action);
    });
  });

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
            disabled={profile.saving}
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
        {profile.saving && <Text accessibilityLiveRegion="polite">{t("profile.saving")}</Text>}
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

      <Dialog open={refused !== null} onOpenChange={(open) => !open && setRefused(null)}>
        <DialogContent closeLabel={t("profile.discard.close")}>
          <DialogHeader>
            <DialogTitle>{t("profile.discard.title")}</DialogTitle>
            <DialogDescription>{errorText(profile.notice, t)}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onPress={() => setRefused(null)}>
              {t("profile.discard.keep")}
            </Button>
            <Button
              variant="destructive"
              onPress={() => {
                const action = refused;
                setRefused(null);
                if (action) navigation.dispatch(action);
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
