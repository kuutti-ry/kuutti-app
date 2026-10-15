import { PhotoCaption } from "@kuutti/schema";
import { useLocalSearchParams } from "expo-router";
import { PhotoZoomScreen } from "@/features/media";

/** The zoom screen; the grid passes what the label needs so nothing is fetched here but the URL. */
export default function PhotoZoomRoute() {
  const params = useLocalSearchParams<{
    id: string;
    blurhash?: string;
    position?: string;
    total?: string;
    caption?: string;
  }>();
  // The grid passes the caption's key (#296); anything else in the link is no caption.
  const caption = PhotoCaption.safeParse(params.caption);
  return (
    <PhotoZoomScreen
      id={params.id}
      blurhash={params.blurhash ?? ""}
      position={Number(params.position ?? "1")}
      total={Number(params.total ?? "1")}
      caption={caption.success ? caption.data : null}
    />
  );
}
