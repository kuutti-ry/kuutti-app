import { PHOTO_CAPTIONS, type Photo, type PhotoCaption } from "@kuutti/schema";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { captionKey } from "./captions";

/**
 * The caption of a photo (#296): one line from a closed list, or none. A key
 * is stored, never the person's words, so nothing is checked and every viewer
 * reads the line in their own language. The chosen line is marked in text,
 * never by colour alone; the list scrolls, since sixteen lines at a large text
 * size outgrow a phone's screen.
 */
export function CaptionDialog({
  photo,
  position,
  onChoose,
  onClose,
}: {
  /** The photo whose caption is being chosen; null keeps the dialog closed. */
  photo: Photo | null;
  /** 1-based, for the title. */
  position: number;
  onChoose: (caption: PhotoCaption | null) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const tap = useHapticTap();
  const { height } = useWindowDimensions();
  const title = t("photos.caption.title", { position });
  const choices: ReadonlyArray<PhotoCaption | null> = [null, ...PHOTO_CAPTIONS];
  return (
    <Dialog open={photo !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent closeLabel={t("photos.dialog.close")}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("photos.caption.explain")}</DialogDescription>
        </DialogHeader>
        <ScrollView style={{ maxHeight: height / 2 }}>
          <View accessibilityRole="radiogroup" accessibilityLabel={title} className="gap-2">
            {choices.map((caption) => {
              const label = caption ? t(captionKey(caption)) : t("photos.caption.none");
              const chosen = (photo?.caption ?? null) === caption;
              const name = chosen ? t("settings.selected", { option: label }) : label;
              return (
                <Button
                  key={caption ?? "none"}
                  variant={chosen ? "default" : "outline"}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: chosen }}
                  // react-native-web reads the ARIA prop, not accessibilityState.
                  aria-checked={chosen}
                  accessibilityLabel={name}
                  onPress={() => {
                    tap();
                    onChoose(caption);
                  }}
                >
                  {name}
                </Button>
              );
            })}
          </View>
        </ScrollView>
      </DialogContent>
    </Dialog>
  );
}
