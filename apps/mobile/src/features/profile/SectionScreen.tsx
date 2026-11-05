import { DISPLAY_NAME_MAX, type ProfileUpdate } from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { BioEditor } from "./BioEditor";
import { ConfirmLeaveDialog } from "./ConfirmLeave";
import { profileErrorText } from "./errorText";
import { FieldEditor } from "./FieldEditor";
import { PromptsEditor } from "./PromptsEditor";
import {
  findSection,
  INTENT_SECTION,
  type SectionId,
  type SectionItem,
  sectionAnswerPath,
  sectionPath,
  sectionTitleKey,
} from "./sections";
import { type HeldDraft, useProfile } from "./useProfile";
import { useRefusedDraft, useSaveOnLeave } from "./useSaveOnLeave";

type Update = (patch: Partial<ProfileUpdate>) => void;

/** The field's own name over it: the basics' and onboarding's name step (#581). */
export function NameEditor({ draft, update }: { draft: ProfileUpdate; update: Update }) {
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
    </View>
  );
}

function ItemEditor({
  item,
  draft,
  update,
  alone,
}: {
  item: SectionItem;
  draft: ProfileUpdate;
  update: Update;
  alone: boolean;
}) {
  if (item === "displayName") return <NameEditor draft={draft} update={update} />;
  if (item === "bio") return <BioEditor draft={draft} update={update} />;
  if (item === "prompts") return <PromptsEditor draft={draft} update={update} />;
  // The identity label is offered after a non-binary gender only, in
  // onboarding and on the gender screen (the registry's rule, #146, #552);
  // here it shows when it was given, to change or clear it, and is not
  // offered to everyone.
  if (item === "identityLabel" && draft.fields.identityLabel === undefined) return null;
  return <FieldEditor field={item} draft={draft} update={update} alone={alone} />;
}

/**
 * One section of the profile (#227): its editors only, and no Save button: it
 * saves on leaving (`useSaveOnLeave`), and a refusal brings it back with the
 * draft and the reason. Not a save per tap: each save is a `profile_saved`
 * research event (ADR-011), and a refused bio is best said on the screen that
 * holds it. Each section saves only its own changes onto the document as
 * stored (useProfile). What one is here for says beside its answer what the
 * answer does, and goes back to What you seek (#542). Opened for one answer
 * (`once`, from a deal-breaker's row or its "Answer it"), the arrow says it
 * goes back there.
 */
export function SectionScreen({ section: id, once = false }: { section: string; once?: boolean }) {
  const { t } = useT();
  const router = useRouter();
  const held = useRefusedDraft<HeldDraft>(id);
  const profile = useProfile(held);
  const { draft, update } = profile;
  const section = findSection(id);
  // Anything that is not a section goes to the list: a typed address, an old link.
  useEffect(() => {
    if (!section) router.replace("/profile");
  }, [section, router]);
  const leaving = useSaveOnLeave<HeldDraft>({
    screen: id,
    path: once ? sectionAnswerPath(id as SectionId) : sectionPath(id as SectionId),
    held: held !== undefined,
    save: () => {
      if (!profile.dirty) return null;
      const { changes } = profile;
      return profile.save().then((notice) => notice && { changes, notice });
    },
  });

  if (!section) return null;

  if (profile.status === "loading") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center p-6">
          <Text accessibilityLiveRegion="polite">{t("load.loading")}</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (profile.status === "error") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-4 p-6">
          <LoadFailed error={profile.error} onRetry={() => void profile.reload()} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={t(sectionTitleKey(section.id))}
        backLabel={t(
          once
            ? "profile.later.backOnce"
            : section.id === INTENT_SECTION
              ? "profile.seek.back"
              : "profile.section.back",
        )}
        onBack={() => router.back()}
      />
      <ScrollView
        contentContainerClassName="flex-grow gap-6 p-6"
        keyboardShouldPersistTaps="handled"
      >
        {profile.notice?.kind === "error" && (
          <Text accessibilityLiveRegion="assertive">{profileErrorText(profile.notice, t)}</Text>
        )}

        {section.id === INTENT_SECTION && <Text>{t("profile.seek.intent.explain")}</Text>}

        {/* No note on the article 9 consent over politics and religion: Settings is the
            one place that names it and takes it back (ADR-019 §4, #204, #239). */}
        {section.items.map((item) => (
          <ItemEditor
            key={item}
            item={item}
            draft={draft}
            update={update}
            alone={section.items.length === 1}
          />
        ))}
      </ScrollView>

      <ConfirmLeaveDialog {...leaving} reason={profileErrorText(profile.notice, t)} />
    </SafeAreaView>
  );
}
