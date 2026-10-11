import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { useSession } from "./session";

/**
 * A session that ends while a screen is open (signed out everywhere from
 * another device, a refresh the API refuses, a deletion) takes the app back
 * to the start, which is the sign-in (#35): on its own the open screen showed
 * its load error (10/10/2026, "Your profile could not be loaded"). Only the
 * change from signed in to signed out moves; a start without a session stays
 * where it is.
 */
export function SignedOutToStart() {
  const session = useSession();
  const router = useRouter();
  const before = useRef(session.status);
  useEffect(() => {
    if (before.current === "signed-in" && session.status === "signed-out") router.replace("/");
    before.current = session.status;
  }, [session.status, router]);
  return null;
}
