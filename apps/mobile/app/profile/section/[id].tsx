import { useLocalSearchParams } from "expo-router";
import { SectionScreen } from "@/features/profile";

export default function ProfileSectionRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SectionScreen section={id ?? ""} />;
}
