import { Stack, useRootNavigationState, useRouter } from "expo-router";
import {
  cloneElement,
  type ReactElement,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useSession } from "./session";

/**
 * A session that ends while a screen is open (signed out everywhere from
 * another device, a refresh the API refuses, a deletion) takes the app back
 * to the start, which is the sign-in (#35): on its own the open screen showed
 * its load error (10/10/2026, "Your profile could not be loaded"). Only the
 * end or replacement of an existing session clears every old route, including
 * the bottom screen and its unsaved state. A cold start and first sign-in
 * retain their route so a bank callback can finish.
 */
export function SignedOutToStart({
  children,
}: {
  children?: ReactElement<{ children?: ReactNode }>;
}) {
  const session = useSession();
  const router = useRouter();
  const root = useRootNavigationState();
  const owner = session.status === "signed-in" ? session.sessionId : null;
  const [navigation, setNavigation] = useState({
    owner,
    generation: 0,
    clearing: false,
    screens: [] as string[],
  });
  // Invalidate the whole tree before committing the next session's render.
  // Initial loading/sign-in preserves a cold callback and its parameters.
  if (navigation.owner !== owner) {
    const changed = navigation.owner !== null;
    setNavigation({
      owner,
      generation: navigation.generation + (changed ? 1 : 0),
      clearing: changed,
      screens: changed ? [...(root?.routes[0]?.state?.routeNames ?? [])] : navigation.screens,
    });
  }
  const applied = useRef(0);
  useLayoutEffect(() => {
    if (navigation.clearing) {
      setNavigation((current) => ({ ...current, clearing: false }));
    } else if (applied.current !== navigation.generation) {
      applied.current = navigation.generation;
      router.replace("/");
    }
  }, [navigation.clearing, navigation.generation, router]);
  if (!children || !navigation.clearing) return children ?? null;
  // Protected-screen removal clears route instances without a beforeRemove
  // veto. Keep the public not-found fallback while clearing, then restore the
  // routes and replace that sole fallback with a fresh start screen.
  return cloneElement(children, {
    children: (
      <Stack.Protected guard={false}>
        {navigation.screens
          .filter((name) => name !== "+not-found")
          .map((name) => (
            <Stack.Screen key={name} name={name} />
          ))}
      </Stack.Protected>
    ),
  });
}
