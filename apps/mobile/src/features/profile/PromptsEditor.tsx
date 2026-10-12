import {
  PROMPT_ANSWER_MAX,
  PROMPT_KEYS,
  PROMPTS_MAX,
  type ProfileUpdate,
  type PromptAnswer,
} from "@kuutti/schema";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { promptKey } from "./keys";
import { answeredPrompts } from "./progress";

/**
 * The prompts of the profile (#47, ADR-009 §4): how many of three hold an
 * answer, the picked ones with their text, and the ones still to pick while
 * fewer than three are taken. The prompts section and the prompts step of
 * onboarding (#146) share it, each with its own heading; the draft and its
 * update are the caller's.
 */
export function PromptsEditor({
  draft,
  update,
}: {
  draft: Pick<ProfileUpdate, "prompts">;
  update: (patch: { prompts: PromptAnswer[] }) => void;
}) {
  const { t } = useT();
  const tap = useHapticTap();
  const chosen = new Set(draft.prompts.map((p) => p.key));
  const progress = { answered: answeredPrompts(draft.prompts), total: PROMPTS_MAX };
  return (
    <View className="gap-3">
      {/* How many are answered, and nothing more: the heading above names the prompts (#239). */}
      <Text variant="muted" accessibilityLabel={t("profile.progress.answered", progress)}>
        {t("profile.progress.short", progress)}
      </Text>
      {draft.prompts.map((prompt) => {
        const question = t(promptKey(prompt.key));
        return (
          <View key={prompt.key} className="gap-2">
            <Text>{question}</Text>
            <Input
              accessibilityLabel={t("profile.prompts.answer", { prompt: question })}
              value={prompt.answer}
              maxLength={PROMPT_ANSWER_MAX}
              multiline
              onChangeText={(answer) =>
                update({
                  prompts: draft.prompts.map((p) => (p.key === prompt.key ? { ...p, answer } : p)),
                })
              }
            />
            <Button
              variant="ghost"
              accessibilityLabel={t("profile.prompts.remove", { prompt: question })}
              onPress={() => {
                tap();
                update({ prompts: draft.prompts.filter((p) => p.key !== prompt.key) });
              }}
            >
              <Text>{t("profile.prompts.removeButton")}</Text>
            </Button>
          </View>
        );
      })}
      {draft.prompts.length < PROMPTS_MAX && (
        <View className="gap-2">
          <Text variant="small">{t("profile.prompts.pick")}</Text>
          <View className="flex-row flex-wrap gap-2">
            {PROMPT_KEYS.filter((key) => !chosen.has(key)).map((key) => (
              <Button
                key={key}
                variant="outline"
                accessibilityState={{ selected: false }}
                onPress={() => {
                  tap();
                  update({ prompts: [...draft.prompts, { key, answer: "" }] });
                }}
              >
                {t(promptKey(key))}
              </Button>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}
