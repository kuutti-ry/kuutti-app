import { useLocalSearchParams } from "expo-router";
import { DealBreakerFieldScreen } from "@/features/profile";

export default function DealBreakerFieldRoute() {
  const { field } = useLocalSearchParams<{ field: string }>();
  return <DealBreakerFieldScreen field={field ?? ""} />;
}
