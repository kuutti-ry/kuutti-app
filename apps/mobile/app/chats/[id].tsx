import { useLocalSearchParams } from "expo-router";
import { ConversationScreen } from "@/features/chat";

/** One conversation (#348), by the id in the link; the screen asks the API whether it is the person's. */
export default function ConversationRoute() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  return <ConversationScreen id={(Array.isArray(id) ? id[0] : id) ?? ""} />;
}
