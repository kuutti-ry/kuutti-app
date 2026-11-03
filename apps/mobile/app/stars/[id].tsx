import { useLocalSearchParams } from "expo-router";
import { RoundScreen } from "@/features/matching";

/** One starred person's card, opened from the list (#575). */
export default function StarredCardRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RoundScreen star={id} />;
}
