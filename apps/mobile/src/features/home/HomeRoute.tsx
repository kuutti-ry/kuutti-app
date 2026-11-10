import { LoadingScreen } from "@/components/LoadFailed";
import { SignInScreen, useSession } from "@/features/identity";
import { HomeScreen } from "./HomeScreen";

/**
 * The first screen (#143, #36): the sign-in for a person who is not signed
 * in, one button and the bank; the home screen for one who is. Nothing while
 * the stored session is still being read.
 */
export function HomeRoute() {
  const session = useSession();
  if (session.status === "loading") {
    return <LoadingScreen />;
  }
  if (session.status === "signed-out") return <SignInScreen />;
  return <HomeScreen />;
}
