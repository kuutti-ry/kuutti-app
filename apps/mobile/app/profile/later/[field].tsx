import { useLocalSearchParams } from "expo-router";
import { LaterFieldScreen } from "@/features/profile";

export default function LaterFieldRoute() {
  const { field, once } = useLocalSearchParams<{ field: string; once?: string }>();
  return <LaterFieldScreen field={field ?? ""} once={once !== undefined} />;
}
