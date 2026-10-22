import { View } from "react-native";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { PASSCODE_LENGTH } from "./passcode";

/**
 * Six digits, hidden as they are typed, under a label that is also the
 * field's name to a screen reader (#418). Anything but digits is dropped, and
 * the sixth digit hands the code on: there is no button to reach for. The
 * phone is told nothing about it being a password or a one-time code, so
 * neither autofill offers what it keeps.
 */
export function PasscodeField({
  label,
  value,
  onChange,
  onComplete,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (digits: string) => void;
  onComplete: (code: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <View className="gap-2">
      <Text variant="small">{label}</Text>
      <Input
        accessibilityLabel={label}
        value={value}
        autoFocus={autoFocus}
        maxLength={PASSCODE_LENGTH}
        inputMode="numeric"
        keyboardType="number-pad"
        secureTextEntry
        textContentType="none"
        autoComplete="off"
        autoCorrect={false}
        onChangeText={(text) => {
          const digits = text.replace(/\D/g, "").slice(0, PASSCODE_LENGTH);
          onChange(digits);
          if (digits.length === PASSCODE_LENGTH) onComplete(digits);
        }}
      />
    </View>
  );
}
