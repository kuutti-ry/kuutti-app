import { Stack } from "expo-router";
import { PhotosScreen } from "@/features/media";

export default function PhotosRoute() {
  return (
    <>
      {/* The grid is reordered by dragging a tile, to the right too (#179), and
          from iOS 26 a rightward pan anywhere on a screen is the stack's back
          gesture, which would take the tile's touch and pop the screen. The
          Done button is this screen's way back (#169). */}
      <Stack.Screen options={{ gestureEnabled: false }} />
      <PhotosScreen />
    </>
  );
}
