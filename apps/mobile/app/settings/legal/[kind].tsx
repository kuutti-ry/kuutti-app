import { useLocalSearchParams } from "expo-router";
import { LegalScreen, legalKindOf } from "@/features/settings";

export default function LegalRoute() {
  const { kind } = useLocalSearchParams<{ kind?: string | string[] }>();
  return <LegalScreen kind={legalKindOf(Array.isArray(kind) ? kind[0] : kind)} />;
}
