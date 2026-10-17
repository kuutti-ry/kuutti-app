import { DISPLAY_NAME_MAX, type ProfileUpdate } from "@kuutti/schema";
import { useNavigation, useRouter } from "expo-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { currentSession } from "@/lib/session";
import { BioEditor } from "./BioEditor";
import { profileErrorText } from "./errorText";
import { FieldEditor } from "./FieldEditor";
import { PromptsEditor } from "./PromptsEditor";
import { findSection, type SectionItem, sectionPath, sectionTitleKey } from "./sections";
import { type HeldDraft, useProfile } from "./useProfile";

type Update = (patch: Partial<ProfileUpdate>) => void;

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
 * Changes the API refused after their section had gone, by section (#238). A
 * refused section comes back on top of whatever is open; each section saves
 * only its own changes onto the document as stored (useProfile), so neither
 * undoes the other.
 */
const refusedDrafts = new Map<string, HeldDraft>();

/**
 * One section of the profile (#227): its editors only, and no Save button.
 * Leaving (the back button, the swipe, Android's back key) saves the
 * section's changes once when something changed. The leaving is never held
 * up: held, the native swipe on iOS popped the screen, put it back and popped
 * it again (#238). So the save goes as the screen goes, and a refusal brings
 * the section back with the draft and the reason, and asks before leaving
 * without saving. Not a save per tap: each save is a `profile_saved` research
 * event (ADR-011), and a refused bio is best said on the screen that holds it.
 */
export function SectionScreen({ section: id }: { section: string }) {
  const { t } = useT();
  const router = useRouter();
  const navigation = useNavigation();
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
    const { changes } = profile;
    void profile.save().then((notice) => {
      // A session that ended has taken the person to the sign-in, and the draft with it.
      if (!notice || !currentSession()) return;
      refusedDrafts.set(id, { changes, notice });
      router.push(sectionPath(section.id));
    });
  });
  useEffect(() => navigation.addListener("beforeRemove", () => onLeave()), [navigation]);

  if (!section) return null;

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
          <LoadFailed
            headline={t("profile.failed")}
            error={profile.error}
            onRetry={() => void profile.reload()}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={t(sectionTitleKey(section.id))}
        backLabel={t("profile.section.back")}
        onBack={() => router.back()}
      />
      <ScrollView
        contentContainerClassName="flex-grow gap-6 p-6"
        keyboardShouldPersistTaps="handled"
      >
        {profile.notice?.kind === "error" && (
          <Text accessibilityLiveRegion="assertive">{profileErrorText(profile.notice, t)}</Text>
        )}

        {/* No note on the article 9 consent over politics and religion: Settings is the
            one place that names it and takes it back (ADR-019 §4, #204, #239). */}
        {section.items.map((item) => (
          <ItemEditor key={item} item={item} draft={draft} update={update} />
        ))}
      </ScrollView>

      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent closeLabel={t("profile.discard.close")}>
          <DialogHeader>
            <DialogTitle>{t("profile.discard.title")}</DialogTitle>
            <DialogDescription>{profileErrorText(profile.notice, t)}</DialogDescription>
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
