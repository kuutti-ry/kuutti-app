import { useLocalSearchParams } from "expo-router";
import { ChatPhotoScreen } from "@/features/chat";

type Param = string | string[] | undefined;

/** The first of a param that came twice; nothing when it did not come. */
const first = (value: Param): string => (Array.isArray(value) ? value[0] : value) ?? "";

/** A whole sequence number from the link, else 0, which the screen reads as no photo. */
function seqOf(value: Param): number {
  const seq = Number(first(value));
  return Number.isInteger(seq) && seq > 0 ? seq : 0;
}

/** A conversation's photo full size (#350), by what the photo bubble put in the link; the screen asks the API whether it is the person's. */
export default function ChatPhotoRoute() {
  const params = useLocalSearchParams<{
    messageId: string | string[];
    conversation?: string | string[];
    seq?: string | string[];
    blurhash?: string | string[];
  }>();
  return (
    <ChatPhotoScreen
      messageId={first(params.messageId)}
      conversation={first(params.conversation)}
      seq={seqOf(params.seq)}
      blurhash={first(params.blurhash)}
    />
  );
}
