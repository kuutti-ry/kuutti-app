import { useLocalSearchParams } from "expo-router";
import { ConsentScreen, consentKindOf } from "@/features/settings";

export default function ConsentRoute() {
  const { kind } = useLocalSearchParams<{ kind?: string | string[] }>();
  return <ConsentScreen kind={consentKindOf(Array.isArray(kind) ? kind[0] : kind)} />;
}
