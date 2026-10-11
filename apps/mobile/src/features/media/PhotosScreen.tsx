import type { PlainMessageKey } from "@kuutti/i18n";
import type { Photo, PhotoRejectionReason, PhotoState } from "@kuutti/schema";
import { useRouter } from "expo-router";
import ArrowLeft from "lucide-react-native/icons/arrow-left";
import ArrowRight from "lucide-react-native/icons/arrow-right";
import Star from "lucide-react-native/icons/star";
import Trash from "lucide-react-native/icons/trash";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
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
import { TOUCH_TARGET } from "@/theme/a11y";
import { useHapticTap } from "@/theme/haptics";
import { PhotoImage } from "./PhotoImage";
import { type PhotosNotice, usePhotos } from "./usePhotos";

const STATE_TEXT: Record<PhotoState, PlainMessageKey> = {
  pending: "photos.state.pending",
  queued: "photos.state.queued",
  approved: "photos.state.approved",
  rejected: "photos.state.rejected",
};

/** A rejected photo says why, in words the moderator chose from a list (#49); never a label name. */
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
  return t(ERROR_TEXT.get(notice.code ?? "") ?? "photos.error.generic");
}

/**
 * The person's photos (#48, rules/mobile.md Images): a grid of thumbs, each
 * with buttons to make it the main photo, move it a step, or remove it after a
 * confirmation; no drag as the only way to do anything (CLAUDE.md
 * Accessibility). Tapping a photo opens the zoom screen, the one place the
 * full variant is requested. A new photo goes through the on-device check and
 * the pre-resize before the upload, with its progress in words.
 */
export function PhotosScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const photos = usePhotos();
  const [removing, setRemoving] = useState<Photo | null>(null);

  const list = photos.list;
  const total = list?.photos.length ?? 0;
  const busy = photos.busy.kind !== "idle";
  const atMax = list !== null && total >= list.maxPhotos;

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
      <ScrollView contentContainerClassName="flex-grow gap-4 p-6">
        <Text variant="h1" accessibilityRole="header">
          {t("photos.title")}
        </Text>
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

        {list && total === 0 && <Text variant="muted">{t("photos.empty")}</Text>}

        <View className="flex-row flex-wrap gap-3">
          {list?.photos.map((photo, index) => (
            <View key={photo.id} className="w-[47%] gap-2">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("photos.open", { position: index + 1 })}
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
                    },
                  });
                }}
              >
                <PhotoImage
                  id={photo.id}
                  variant="thumb"
                  blurhash={photo.blurhash}
                  accessibilityLabel={t("photos.imageLabel", { position: index + 1, total })}
                  style={{ width: "100%", aspectRatio: 1 }}
                  onRefused={(code) => {
                    if (code === "photo_budget_exceeded") photos.reportRefusal(code);
                  }}
                />
              </Pressable>
              <View className="gap-0.5">
                {index === 0 && <Text variant="small">{t("photos.main")}</Text>}
                <Text variant="muted">{stateText(photo, t)}</Text>
              </View>
              {/* Two rows on purpose: four 44-point targets never fit one row of a half-width tile, and a wrap that depends on the font size put the remove button on a row of its own. */}
              <View className="gap-1">
                <View className="flex-row gap-1">
                  {index !== 0 && (
                    <Button
                      variant="outline"
                      size="icon"
                      accessibilityLabel={t("photos.makeMain")}
                      disabled={busy}
                      onPress={() => {
                        tap();
                        void photos.makeMain(photo.id);
                      }}
                    >
                      <Icon as={Star} />
                    </Button>
                  )}
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
                {total > 1 && (
                  <View className="flex-row gap-1">
                    {index !== 0 && (
                      <Button
                        variant="outline"
                        size="icon"
                        accessibilityLabel={t("photos.moveEarlier")}
                        disabled={busy}
                        onPress={() => {
                          tap();
                          void photos.move(photo.id, -1);
                        }}
                      >
                        <Icon as={ArrowLeft} />
                      </Button>
                    )}
                    {index !== total - 1 && (
                      <Button
                        variant="outline"
                        size="icon"
                        accessibilityLabel={t("photos.moveLater")}
                        disabled={busy}
                        onPress={() => {
                          tap();
                          void photos.move(photo.id, 1);
                        }}
                      >
                        <Icon as={ArrowRight} />
                      </Button>
                    )}
                  </View>
                )}
              </View>
            </View>
          ))}
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
