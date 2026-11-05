import type { PlainMessageKey } from "@kuutti/i18n";
import {
  PHOTOS_FOR_COMPLETENESS,
  type Photo,
  type PhotoRejectionReason,
  type PhotoState,
} from "@kuutti/schema";
import { useRouter } from "expo-router";
import Hourglass from "lucide-react-native/icons/hourglass";
import Trash from "lucide-react-native/icons/trash";
import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { sayAloud } from "@/components/Notice";
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

/** A rejected photo says why, in words from a list (#49): a moderator's choice, the check's (#206), or the night's (#376); never a label name. */
const REJECTED_TEXT: Record<PhotoRejectionReason, PlainMessageKey> = {
  nudity: "photos.rejected.nudity",
  no_person: "photos.rejected.no_person",
  several_people: "photos.rejected.several_people",
  minor: "photos.rejected.minor",
  violence: "photos.rejected.violence",
  contact_details: "photos.rejected.contact_details",
  other: "photos.rejected.other",
  not_reviewed: "photos.rejected.not_reviewed",
};

/** Waiting for the check or a person (#376): the tile is dimmed under an hourglass, and the same words say so for both (#581). */
const inReview = (state: PhotoState) => state === "pending" || state === "queued";

/** A refused photo says why where it can; one that is through says nothing, the silence being the word for it (#581). */
const refusalText = (photo: Photo, t: ReturnType<typeof useT>["t"]): string =>
  t(photo.rejectionReason ? REJECTED_TEXT[photo.rejectionReason] : "photos.state.rejected");

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

/** From here half a phone's width breaks a caption's longest word in the middle ("kuvateksti", at 390 pt and less). */
const ONE_COLUMN_FONT_SCALE = 1.3;

/**
 * The person's photos (#48, rules/mobile.md Images): a grid of thumbs,
 * reordered by holding a tile and dragging it, the first slot the main photo
 * (#179), the same moves as accessibility actions on every tile; each has a
 * button to remove it after a confirmation. Tapping a photo opens the zoom
 * screen, the one place the full variant is requested. A new photo goes
 * through the on-device check and the pre-resize before the upload, whose
 * progress is in words. The count is drawn only at the limit, where Add a photo
 * stops and needs a reason; below it the grid shows the count, and each change
 * of it is said to a screen reader, the one word that a photo landed (#581).
 * It is onboarding's photos step too (#146, #581): under that step's number,
 * heading and line, with the step's Continue in place of Done.
 */
export function PhotosScreen({
  step,
}: {
  /**
   * Onboarding's step, when this is it: where it stands, whether the status its
   * Continue asked for is still being read, and that Continue, the way on once
   * two photos count as the API counts them.
   */
  step?: { position: number; total: number; reading: boolean; onContinue: () => void };
}) {
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
  const { fontScale } = useWindowDimensions();
  const busy = photos.busy.kind !== "idle";
  const atMax = list !== null && total >= list.maxPhotos;
  // The API's rule for the step: a refused photo does not count, one in review does.
  const enough =
    (list?.photos.filter((photo) => photo.state !== "rejected").length ?? 0) >=
    PHOTOS_FOR_COMPLETENESS;
  const count = list && t("photos.count", { photos: total, max: list.maxPhotos });
  const countSaid = useRef<string | null>(null);
  useEffect(() => {
    if (count === null) return;
    if (countSaid.current !== null) sayAloud(count);
    countSaid.current = count;
  }, [count]);

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
    photos.busy.kind === "uploading"
      ? t("photos.uploading", { percent: photos.busy.percent })
      : null;

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView
        contentContainerClassName="flex-grow gap-4 p-6"
        scrollEnabled={drag.active === null}
      >
        {step && (
          <Text variant="muted" accessibilityLiveRegion="polite">
            {t("onboarding.progress", { step: step.position, total: step.total })}
          </Text>
        )}
        <Text variant="h1" accessibilityRole="header">
          {t(step ? "onboarding.photos.title" : "photos.title")}
        </Text>
        {step && <Text>{t("onboarding.photos.explain")}</Text>}
        {list && <Text>{t("photos.explain")}</Text>}

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
                className={fontScale >= ONE_COLUMN_FONT_SCALE ? "w-full" : "w-[47%]"}
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
                      {/* A sign on the photo itself, not only a line under it (#376):
                          shape and dimming, never colour alone; the words below say it
                          to everyone, so the sign is hidden from a screen reader. */}
                      {inReview(photo.state) && (
                        <View
                          testID={`photo-in-review-${index + 1}`}
                          pointerEvents="none"
                          accessibilityElementsHidden
                          importantForAccessibility="no-hide-descendants"
                          className="absolute inset-0 items-center justify-center bg-background/60"
                        >
                          <View className="rounded-full border border-border bg-background p-3">
                            <Icon as={Hourglass} size={32} />
                          </View>
                        </View>
                      )}
                    </Pressable>
                    {(photo.id === mainId || photo.state !== "approved" || words !== null) && (
                      <View className="gap-0.5">
                        {photo.id === mainId && <Text variant="small">{t("photos.main")}</Text>}
                        {inReview(photo.state) && (
                          <View className="flex-row items-center gap-1">
                            <Icon as={Hourglass} size={16} />
                            {/* Wraps beside the icon at the largest text sizes, never clipped. */}
                            <Text variant="small" className="shrink">
                              {t("photos.state.pending")}
                            </Text>
                          </View>
                        )}
                        {photo.state === "rejected" && (
                          <Text variant="muted">{refusalText(photo, t)}</Text>
                        )}
                        {words && <PhotoDescriptionText text={words} />}
                      </View>
                    )}
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
                        accessibilityLabel={t("photos.appeal.label", { position: index + 1 })}
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

        {/* Why Add a photo stops, beside it. */}
        {atMax && <Text variant="muted">{count}</Text>}
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
        {step ? (
          <Button
            // A failed read shows the upload's fallback above, and this reads the list again.
            disabled={busy || step.reading || (photos.status !== "error" && !enough)}
            onPress={() => {
              tap();
              // A photo refused since the list was read keeps the step here: the tile says why.
              photos.dismissNotice();
              void photos.reload();
              step.onContinue();
            }}
          >
            {t("onboarding.continue")}
          </Button>
        ) : (
          // Headers are hidden app-wide: this is the way back to the profile.
          <Button
            variant="outline"
            onPress={() => {
              tap();
              router.back();
            }}
          >
            {t("photos.done")}
          </Button>
        )}
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
