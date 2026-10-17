import { Stack, useLocalSearchParams } from "expo-router";
import { PhotosScreen } from "@/features/media";

/** Onboarding's step when it opened the screen (#146): whole numbers, the step within the total; anything else is none. */
function progressOf(params: { step?: string | string[]; total?: string | string[] }) {
  const step = Number(params.step);
  const total = Number(params.total);
  if (!Number.isInteger(step) || !Number.isInteger(total) || step < 1 || step > total) {
    return undefined;
  }
  return { step, total };
}

export default function PhotosRoute() {
  const params = useLocalSearchParams<{ step?: string; total?: string }>();
  return (
    <>
      {/* The grid is reordered by dragging a tile, to the right too (#179), and
          from iOS 26 a rightward pan anywhere on a screen is the stack's back
          gesture, which would take the tile's touch and pop the screen. The
          Done button is this screen's way back (#169). */}
      <Stack.Screen options={{ gestureEnabled: false }} />
      <PhotosScreen progress={progressOf(params)} />
    </>
  );
}
