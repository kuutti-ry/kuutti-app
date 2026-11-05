import { Stack } from "expo-router";
import { OnboardingScreen } from "@/features/identity";

export default function OnboardingRoute() {
  return (
    <>
      {/* The photos step's grid is reordered by dragging a tile, to the right too
          (#179), and from iOS 26 a rightward pan anywhere on a screen is the
          stack's back gesture, which would take the tile's touch. Nothing under
          this screen is a step to go back to: the gate sends the person here again. */}
      <Stack.Screen options={{ gestureEnabled: false }} />
      <OnboardingScreen />
    </>
  );
}
