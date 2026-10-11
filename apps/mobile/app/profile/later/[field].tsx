import { useLocalSearchParams } from "expo-router";
import { LaterFieldScreen } from "@/features/profile";

export default function LaterFieldRoute() {
  const { field } = useLocalSearchParams<{ field: string }>();
  return <LaterFieldScreen field={field ?? ""} />;
}
