import { useLocalSearchParams } from "expo-router";
import { SectionScreen } from "@/features/profile";

export default function ProfileSectionRoute() {
  const { id, once } = useLocalSearchParams<{ id: string; once?: string }>();
  return <SectionScreen section={id ?? ""} once={once !== undefined} />;
}
