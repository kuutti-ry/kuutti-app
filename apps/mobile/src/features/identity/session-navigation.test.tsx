import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { router, Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { renderRouter } from "expo-router/testing-library";
import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import NotFoundRoute from "../../../app/+not-found";
import { SignedOutToStart } from "./SignedOutToStart";
import { SessionProvider, useSession } from "./session";

// A mocked replace cannot show which screens, local data and leave listeners
// survive under the new screen. Keep Expo Router and its Stack real here.
jest.unmock("expo-router");

const FIRST = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const SECOND = "4c6a35bc-8c31-45b4-823f-3dc77809c228";
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const tokens = (sessionId = FIRST, seed = "first") => ({
  sessionId,
  accessToken: token(`access-${seed}`),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: `${token("family")}.${token(`refresh-${seed}`)}`,
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
});

let nextInstance = 0;
let heldRemovals = 0;
const mounted = new Set<string>();
const disposed: string[] = [];

/** Record actual effect cleanup, including screens hidden below the top one. */
function useLifetime(name: string) {
  const [instance] = useState(() => `${name}:${++nextInstance}`);
  useEffect(() => {
    mounted.add(instance);
    return () => {
      mounted.delete(instance);
      disposed.push(instance);
    };
  }, [instance]);
}

function SessionStatus() {
  const session = useSession();
  return (
    <Text testID="session-status">
      {session.status === "signed-in" ? session.sessionId : session.status}
    </Text>
  );
}

function Root() {
  return (
    <SessionProvider>
      <SessionStatus />
      <SignedOutToStart>
        <Stack screenOptions={{ headerShown: false, animation: "none" }} />
      </SignedOutToStart>
    </SessionProvider>
  );
}

function Start() {
  // The original bottom screen must also be disposed; popping everything
  // above it would retain its state, effects and session-owned closures.
  useLifetime("start");
  return <Text>Start</Text>;
}

function PrivateScreen({ name, unsaved = false }: { name: string; unsaved?: boolean }) {
  const session = useSession();
  const navigation = useNavigation();
  useLifetime(name);
  // Like fetched screen data, this survives a provider update unless the
  // screen itself is removed. Only synthetic content is used in this test.
  const [content] = useState(
    () => `Private ${name} for ${session.status === "signed-in" ? session.sessionId : "nobody"}`,
  );
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (!unsaved) return;
    return navigation.addListener("beforeRemove", (event) => {
      heldRemovals += 1;
      event.preventDefault();
    });
  }, [navigation, unsaved]);
  return (
    <View>
      <Text testID="private-content">{content}</Text>
      <TextInput accessibilityLabel={`${name} draft`} value={draft} onChangeText={setDraft} />
    </View>
  );
}

function Support() {
  useLifetime("support");
  return <Text>Public support</Text>;
}

function Callback() {
  useLifetime("callback");
  const { code } = useLocalSearchParams<{ code: string }>();
  return <Text>{`Callback code: ${code}`}</Text>;
}

const ROUTES = {
  _layout: Root,
  "+not-found": NotFoundRoute,
  index: Start,
  "private-one": () => <PrivateScreen name="one" />,
  "private-two": () => <PrivateScreen name="two" />,
  unsaved: () => <PrivateScreen name="editor" unsaved />,
  support: Support,
  auth: Callback,
};

async function opened(initialUrl = "/", ...paths: string[]) {
  // RNTL 14 renders asynchronously; renderRouter's getters sit on its promise
  // (the same convention as chat/notice.test.tsx).
  const view = renderRouter(ROUTES, { initialUrl });
  await view;
  await waitFor(() =>
    expect(screen.getByTestId("session-status").props.children).not.toBe("loading"),
  );
  for (const path of paths) await act(async () => router.push(path));
  return { getPathname: () => view.getPathname() };
}

function expectDisposed(instances: string[]) {
  for (const instance of instances) {
    expect(disposed).toContain(instance);
    expect(mounted.has(instance)).toBe(false);
  }
  // Inactive native-stack screens can be hidden from ordinary queries.
  expect(screen.queryAllByTestId("private-content", { includeHiddenElements: true })).toEqual([]);
}

beforeEach(async () => {
  await clearSession();
  nextInstance = 0;
  heldRemovals = 0;
  mounted.clear();
  disposed.length = 0;
});

afterEach(async () => {
  await cleanup();
  // renderRouter installs fake timers.
  jest.useRealTimers();
});

describe("the navigator belongs to its session", () => {
  it("disposes every old screen on sign-out and Back cannot recover its private content", async () => {
    await saveSession(tokens());
    const app = await opened("/", "/private-one", "/private-two");
    const previous = [...mounted];
    expect(previous).toHaveLength(3);
    expect(screen.getByText(`Private two for ${FIRST}`)).toBeTruthy();
    expect(router.canGoBack()).toBe(true);

    await act(async () => clearSession());

    expect(app.getPathname()).toBe("/");
    expect(screen.getByText("Start")).toBeTruthy();
    expect(screen.getByTestId("session-status").props.children).toBe("signed-out");
    expectDisposed(previous);
    expect(router.canGoBack()).toBe(false);
    // Exercise Back on a valid public stack, without an unhandled Back at
    // its root masking which screen it could return to.
    await act(async () => router.push("/support"));
    await act(async () => router.back());
    expect(app.getPathname()).toBe("/");
    expect(screen.getByText("Start")).toBeTruthy();
    expectDisposed(previous);
    expect(router.canGoBack()).toBe(false);
  });

  it("disposes the former session's entire stack when another session replaces it", async () => {
    await saveSession(tokens());
    const app = await opened("/", "/private-one", "/private-two");
    const previous = [...mounted];
    expect(previous).toHaveLength(3);

    await act(async () => saveSession(tokens(SECOND, "replacement")));

    expect(screen.getByTestId("session-status").props.children).toBe(SECOND);
    expect(app.getPathname()).toBe("/");
    expectDisposed(previous);
    expect(router.canGoBack()).toBe(false);
    await act(async () => router.push("/private-one"));
    expect(screen.getByText(`Private one for ${SECOND}`)).toBeTruthy();
    expect(
      screen.queryByText(`Private one for ${FIRST}`, { includeHiddenElements: true }),
    ).toBeNull();
    await act(async () => router.back());
    expect(app.getPathname()).toBe("/");
    expectDisposed(previous);
  });

  it("preserves the screens, history and draft when tokens rotate within the same session", async () => {
    await saveSession(tokens());
    const app = await opened("/", "/private-one", "/private-two");
    await fireEvent.changeText(screen.getByLabelText("two draft"), "Unsent synthetic draft");
    const previous = [...mounted];
    const disposedBeforeRefresh = [...disposed];

    await act(async () => saveSession(tokens(FIRST, "rotated")));

    expect(app.getPathname()).toBe("/private-two");
    expect([...mounted]).toEqual(previous);
    expect(disposed).toEqual(disposedBeforeRefresh);
    expect(screen.getByLabelText("two draft").props.value).toBe("Unsent synthetic draft");
    await act(async () => router.back());
    expect(app.getPathname()).toBe("/private-one");
    expect(screen.getByText(`Private one for ${FIRST}`)).toBeTruthy();
  });

  it("tears down unsaved screens even when their beforeRemove listener vetoes ordinary Back", async () => {
    await saveSession(tokens());
    const app = await opened("/", "/private-one", "/unsaved");
    const previous = [...mounted];
    expect(previous).toHaveLength(3);

    await act(async () => router.back());
    expect(heldRemovals).toBe(1);
    expect(app.getPathname()).toBe("/unsaved");
    expect([...mounted]).toEqual(previous);

    await act(async () => clearSession());

    expect(app.getPathname()).toBe("/");
    expectDisposed(previous);
    expect(router.canGoBack()).toBe(false);
    const heldBeforePublicBack = heldRemovals;
    await act(async () => router.push("/support"));
    await act(async () => router.back());
    expect(app.getPathname()).toBe("/");
    expect(heldRemovals).toBe(heldBeforePublicBack);
    expectDisposed(previous);
  });

  it("preserves a public deep link when a cold start has no session", async () => {
    const app = await opened("/support");

    expect(screen.getByTestId("session-status").props.children).toBe("signed-out");
    expect(app.getPathname()).toBe("/support");
    expect(screen.getByText("Public support")).toBeTruthy();
    expect(disposed).toEqual([]);
  });

  it("preserves a cold auth callback and its parameters through the first sign-in", async () => {
    const app = await opened("/auth?code=synthetic-one-time-code");
    const previous = [...mounted];
    expect(previous).toHaveLength(1);
    expect(app.getPathname()).toBe("/auth");
    expect(screen.getByText("Callback code: synthetic-one-time-code")).toBeTruthy();

    await act(async () => saveSession(tokens()));

    expect(screen.getByTestId("session-status").props.children).toBe(FIRST);
    expect(app.getPathname()).toBe("/auth");
    expect(screen.getByText("Callback code: synthetic-one-time-code")).toBeTruthy();
    expect([...mounted]).toEqual(previous);
    expect(disposed).toEqual([]);
  });
});
