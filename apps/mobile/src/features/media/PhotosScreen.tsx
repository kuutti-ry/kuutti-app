import type { PlainMessageKey } from "@kuutti/i18n";
import type { Photo, PhotoRejectionReason, PhotoState } from "@kuutti/schema";
import { useRouter } from "expo-router";
import Trash from "lucide-react-native/icons/trash";
import { useState } from "react";
import { Animated, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { usePhotoDescriptionText } from "@/lib/photo-descriptions";
import { TOUCH_TARGET } from "@/theme/a11y";
import { useHapticTap } from "@/theme/haptics";
import { useMotionDuration } from "@/theme/useReducedMotion";
import { CaptionDialog } from "./CaptionDialog";
import { captionKey } from "./captions";
import { PhotoDescriptionText } from "./PhotoDescriptionText";
import { PhotoImage } from "./PhotoImage";
import { PhotoTip } from "./tips";
import { useDragOrder } from "./useDragOrder";
import { type PhotosNotice, usePhotos } from "./usePhotos";

const STATE_TEXT: Record<PhotoState, PlainMessageKey> = {
  pending: "photos.state.pending",
  queued: "photos.state.queued",
  approved: "photos.state.approved",
  rejected: "photos.state.rejected",
};

/** A rejected photo says why, in words from a list (#49): a moderator's choice, or the check's for several people (#206); never a label name. */
const REJECTED_TEXT: Record<PhotoRejectionReason, PlainMessageKey> = {
  nudity: "photos.rejected.nudity",
  no_person: "photos.rejected.no_person",
  several_people: "photos.rejected.several_people",
  minor: "photos.rejected.minor",
  violence: "photos.rejected.violence",
  contact_details: "photos.rejected.contact_details",
  other: "photos.rejected.other",
};

function stateText(photo: Photo, t: ReturnType<typeof useT>["t"]): string {
  if (photo.state === "rejected" && photo.rejectionReason) {
    return t(REJECTED_TEXT[photo.rejectionReason]);
  }
  return t(STATE_TEXT[photo.state]);
}

/**
 * The API's refusals the screen has its own words for; a Map so a code like
 * `toString` finds nothing rather than a prototype member.
 */
const ERROR_TEXT: ReadonlyMap<string, PlainMessageKey> = new Map([
  ["photo_limit", "photos.error.photo_limit"],
  ["photo_unsupported", "photos.error.photo_unsupported"],
  ["photo_not_appealable", "photos.error.photo_not_appealable"],
  ["photo_invalid", "photos.error.photo_invalid"],
  ["photo_too_many_pixels", "photos.error.tooLarge"],
  ["payload_too_large", "photos.error.tooLarge"],
  ["media_busy", "photos.error.media_busy"],
  ["media_unavailable", "photos.error.media_unavailable"],
  ["photo_order_invalid", "photos.error.photo_order_invalid"],
  ["photo_budget_exceeded", "photos.error.photo_budget_exceeded"],
]);

function noticeText(notice: PhotosNotice, t: ReturnType<typeof useT>["t"]): string {
  if (notice.kind === "refused_local") return t("photos.refused.local");
  if (notice.kind === "permission") return t("photos.error.permission");
  if (notice.kind === "caption_failed") return t("photos.caption.failed");
  return t(ERROR_TEXT.get(notice.code ?? "") ?? "photos.error.generic");
}

/**
 * The moves a tile offers a screen reader or a switch user (#179): the same
 * three the drag makes, as named actions on every tile, so a gesture is never
 * the only way (CLAUDE.md Accessibility). A move that cannot happen, earlier
 * from the first slot, main for the main one, changes nothing.
 */
const TILE_ACTIONS: ReadonlyArray<{ name: string; key: PlainMessageKey }> = [
  { name: "moveEarlier", key: "photos.moveEarlier" },
  { name: "moveLater", key: "photos.moveLater" },
  { name: "makeMain", key: "photos.makeMain" },
];

/**
 * The person's photos (#48, rules/mobile.md Images): a grid of thumbs,
 * reordered by holding a tile and dragging it, the first slot the main photo
 * (#179), the same moves as accessibility actions on every tile; each has a
 * button to remove it after a confirmation. Tapping a photo opens the zoom
 * screen, the one place the full variant is requested. A new photo goes
 * through the on-device check and the pre-resize before the upload, with its
 * progress in words. Opened from onboarding, it says that step's "Step x of
 * n" as every other step does (#146).
 */
export function PhotosScreen({ progress }: { progress?: { step: number; total: number } }) {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const photos = usePhotos();
  // What the check saw in each photo (#296): in its label after the caption, and under it when the setting asks.
  const described = usePhotoDescriptionText();
  const [removing, setRemoving] = useState<Photo | null>(null);
  // The photo whose caption is being chosen (#296), read from the list so the dialog marks the line as it stands.
  const [captioningId, setCaptioningId] = useState<string | null>(null);

  const list = photos.list;
  const captioningIndex = list?.photos.findIndex((photo) => photo.id === captioningId) ?? -1;
  const captioning = captioningIndex >= 0 ? (list?.photos[captioningIndex] ?? null) : null;
  const captionText = (photo: Photo) =>
    photo.caption ? t(captionKey(photo.caption)) : t("photos.caption.none");
  const total = list?.photos.length ?? 0;
  // The main photo is the first one others see: the first approved in the
  // owner's order, as the card and the tips read it (ADR-009 §4). The first
  // tile while it is still in review is not it (#239).
  const mainId = list?.photos.find((photo) => photo.state === "approved")?.id;
  const busy = photos.busy.kind !== "idle";
  const atMax = list !== null && total >= list.maxPhotos;

  const drag = useDragOrder({
    count: total,
    duration: useMotionDuration(150),
    onDrop: (from, to) => void photos.moveTo(from, to),
  });
  const tileActions = TILE_ACTIONS.map(({ name, key }) => ({ name, label: t(key) }));
  const act = (photo: Photo, action: string) => {
    if (busy) return;
    if (action === "moveEarlier") void photos.move(photo.id, -1);
    if (action === "moveLater") void photos.move(photo.id, 1);
    if (action === "makeMain") void photos.makeMain(photo.id);
  };

  const busyText =
    photos.busy.kind === "picking"
      ? t("photos.picking")
      : photos.busy.kind === "preparing"
        ? t("photos.preparing")
        : photos.busy.kind === "uploading"
          ? t("photos.uploading", { percent: photos.busy.percent })
          : null;

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView
        contentContainerClassName="flex-grow gap-4 p-6"
        scrollEnabled={drag.active === null}
      >
        <Text variant="h1" accessibilityRole="header">
          {t("photos.title")}
        </Text>
        {progress && (
          <Text variant="muted" accessibilityLiveRegion="polite">
            {t("onboarding.progress", progress)}
          </Text>
        )}
        {list && <Text>{t("photos.explain", { max: list.maxPhotos })}</Text>}
        {list && (
          <Text variant="muted" accessibilityLiveRegion="polite">
            {t("photos.count", { photos: total, max: list.maxPhotos })}
          </Text>
        )}

        {photos.notice && (
          <Card>
            <CardHeader>
              {/* The words carry the state; nothing here is colour alone. */}
              <CardDescription accessibilityLiveRegion="assertive">
                {noticeText(photos.notice, t)}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onPress={photos.dismissNotice}>
                {t("photos.notice.dismiss")}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* By the photos it is about (#287): one advisory tip, the main photo's first. */}
        {list && (
          <PhotoTip tips={list.tips} fishSpecies={list.fishSpecies} mainId={mainId ?? null} />
        )}

        {list && total === 0 && <Text variant="muted">{t("photos.empty")}</Text>}

        <View className="flex-row flex-wrap gap-3">
          {list?.photos.map((photo, index) => {
            const tile = drag.tile(index);
            const words = described.shown ? described.describe(photo.description) : null;
            return (
              // The slot: laid out by the grid, measured for the drag, and the
              // view that holds the touch once the tile is lifted. Nothing for
              // a screen reader to land on; the tile inside is the control.
              <View
                key={photo.id}
                className="w-[47%]"
                style={{ zIndex: tile.zIndex }}
                onLayout={tile.onLayout}
                accessible={false}
                testID={`photo-tile-${index + 1}`}
                {...tile.responder}
              >
                <Animated.View style={{ transform: tile.transform }}>
                  <View className="gap-2">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("photos.open", { position: index + 1 })}
                      accessibilityActions={tileActions}
                      onAccessibilityAction={(event) => act(photo, event.nativeEvent.actionName)}
                      className="overflow-hidden rounded-lg bg-muted"
                      style={{ minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET }}
                      onPress={() => {
                        tap();
                        router.push({
                          pathname: "/photos/[id]",
                          params: {
                            id: photo.id,
                            blurhash: photo.blurhash,
                            position: String(index + 1),
                            total: String(total),
                            ...(photo.caption ? { caption: photo.caption } : {}),
                            ...(photo.description
                              ? { description: JSON.stringify(photo.description) }
                              : {}),
                          },
                        });
                      }}
                      onLongPress={() => {
                        if (busy) return;
                        tap();
                        tile.onLongPress();
                      }}
                      onPressOut={tile.onPressOut}
                    >
                      <PhotoImage
                        id={photo.id}
                        variant="thumb"
                        blurhash={photo.blurhash}
                        accessibilityLabel={described.label(
                          photo.caption
                            ? t("photos.imageLabelCaption", {
                                position: index + 1,
                                total,
                                caption: t(captionKey(photo.caption)),
                              })
                            : t("photos.imageLabel", { position: index + 1, total }),
                          photo.description,
                        )}
                        style={{ width: "100%", aspectRatio: 1 }}
                        onRefused={(code) => {
                          if (code === "photo_budget_exceeded") photos.reportRefusal(code);
                        }}
                      />
                    </Pressable>
                    <View className="gap-0.5">
                      {photo.id === mainId && <Text variant="small">{t("photos.main")}</Text>}
                      <Text variant="muted">{stateText(photo, t)}</Text>
                      {words && <PhotoDescriptionText text={words} />}
                    </View>
                    {/* The owner's line under the photo (#296): the button says the line, or asks for one. */}
                    <Button
                      variant="outline"
                      accessibilityLabel={t("photos.caption.open", { position: index + 1 })}
                      accessibilityValue={{ text: captionText(photo) }}
                      disabled={busy}
                      onPress={() => {
                        tap();
                        setCaptioningId(photo.id);
                      }}
                    >
                      {photo.caption ? t(captionKey(photo.caption)) : t("photos.caption.add")}
                    </Button>
                    {photo.state === "rejected" && photo.appealable && (
                      <Button
                        variant="outline"
                        accessibilityLabel={t("photos.appeal")}
                        disabled={busy}
                        onPress={() => {
                          tap();
                          void photos.appeal(photo.id);
                        }}
                      >
                        {t("photos.appeal")}
                      </Button>
                    )}
                    <View className="flex-row gap-1">
                      <Button
                        variant="outline"
                        size="icon"
                        accessibilityLabel={t("photos.remove")}
                        disabled={busy}
                        onPress={() => {
                          tap();
                          setRemoving(photo);
                        }}
                      >
                        <Icon as={Trash} />
                      </Button>
                    </View>
                  </View>
                </Animated.View>
              </View>
            );
          })}
        </View>

        {busyText && (
          <Card>
            <CardContent>
              <Text accessibilityLiveRegion="polite">{busyText}</Text>
            </CardContent>
          </Card>
        )}

        <Button
          accessibilityLabel={t("photos.add")}
          disabled={busy || atMax || photos.status !== "ready"}
          onPress={() => {
            tap();
            void photos.add();
          }}
        >
          <Text>{t("photos.add")}</Text>
        </Button>
        {/* Headers are hidden app-wide; from onboarding this is the way on to the next step. */}
        <Button
          variant="outline"
          onPress={() => {
            tap();
            router.back();
          }}
        >
          {t("photos.done")}
        </Button>
      </ScrollView>

      <CaptionDialog
        photo={captioning}
        position={captioningIndex + 1}
        onChoose={(line) => {
          const photo = captioning;
          setCaptioningId(null);
          if (photo) void photos.caption(photo.id, line);
        }}
        onClose={() => setCaptioningId(null)}
      />

      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent closeLabel={t("photos.dialog.close")}>
          <DialogHeader>
            <DialogTitle>{t("photos.remove.title")}</DialogTitle>
            <DialogDescription>{t("photos.remove.body")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onPress={() => setRemoving(null)}>
              {t("photos.remove.cancel")}
            </Button>
            <Button
              variant="destructive"
              onPress={() => {
                const photo = removing;
                setRemoving(null);
                if (photo) void photos.remove(photo.id);
              }}
            >
              {t("photos.remove.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SafeAreaView>
  );
}
