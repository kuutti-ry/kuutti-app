import { act, fireEvent, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { renderRouter } from "expo-router/testing-library";
import type { ReactNode } from "react";
import { Pressable, Text } from "react-native";
import { LocaleProvider } from "@/lib/locale";
import { takeNotice, useHandToList } from "./notice";

// The hand to the list after a report, a block or an end (#351, #476), on
// expo-router's own stack: jest.setup.js mocks the router for every other
// test, and a mock cannot show what is left under the list (#491).
jest.unmock("expo-router");

/** A screen's hand to the list: a conversation's, or a photo's of conversation c1. */
function HandOver({ photoOf }: { photoOf?: string }) {
  const handToList = useHandToList(photoOf);
  return (
    <Pressable accessibilityRole="button" onPress={() => handToList("reported", true)}>
      <Text>Hand over from the {photoOf === undefined ? "conversation" : "photo"}</Text>
    </Pressable>
  );
}

const ROUTES = {
  index: () => <Text>Home</Text>,
  round: () => <Text>Today's round</Text>,
  "chats/index": () => <Text>Conversations</Text>,
  "chats/[id]": () => <HandOver />,
  "chats/photo/[messageId]": () => <HandOver photoOf="c1" />,
};

const wrapper = ({ children }: { children: ReactNode }) => (
  <LocaleProvider>{children}</LocaleProvider>
);

/** The app at `initialUrl`, then each of `opened` pushed on it, as a tap would. */
async function opened(initialUrl: string, ...paths: string[]) {
  // RNTL 14 renders asynchronously; renderRouter's getters sit on its promise.
  const view = renderRouter(ROUTES, { initialUrl, wrapper });
  await view;
  for (const path of paths) await act(async () => router.push(path));
  return {
    pathname: () => view.getPathname(),
    /** The app's stack, under expo-router's own __root: its screens, bottom first, by their route files. */
    stack: () => {
      const root = view.getRouterState()?.routes[0] as
        | { name: string; state?: { routes: { name: string }[] } }
        | undefined;
      expect(root?.name).toBe("__root");
      return root?.state?.routes.map((route) => route.name);
    },
  };
}

const handOver = async (from: "conversation" | "photo") => {
  await act(async () =>
    fireEvent.press(screen.getByRole("button", { name: `Hand over from the ${from}` })),
  );
};

afterEach(() => {
  takeNotice();
  // renderRouter fakes the timers.
  jest.useRealTimers();
});

describe("handing over to the list (#491)", () => {
  it("leaves the list on the round after a photo's report in a conversation the match screen opened, and Back goes to the round", async () => {
    const app = await opened("/round", "/chats/c1", "/chats/photo/m1");
    expect(app.stack()).toEqual(["round", "chats/[id]", "chats/photo/[messageId]"]);
    await handOver("photo");
    expect(app.pathname()).toBe("/chats");
    expect(app.stack()).toEqual(["round", "chats/index"]);
    expect(screen.getByText("Conversations")).toBeTruthy();
    expect(takeNotice()).toBe("reported");
    // Back finds the round, not the reported conversation's "no longer available".
    await act(async () => router.back());
    expect(app.pathname()).toBe("/round");
    expect(screen.getByText("Today's round")).toBeTruthy();
  });

  it("goes back down to the list after a photo's report in a conversation the list opened, as before", async () => {
    const app = await opened("/chats", "/chats/c1", "/chats/photo/m1");
    await handOver("photo");
    expect(app.pathname()).toBe("/chats");
    expect(app.stack()).toEqual(["chats/index"]);
  });

  it("takes both photos a quick double tap pushed, and leaves the list on the round", async () => {
    const app = await opened("/round", "/chats/c1", "/chats/photo/m1", "/chats/photo/m1");
    await handOver("photo");
    expect(app.stack()).toEqual(["round", "chats/index"]);
  });

  it("puts the list in the place of a photo an outside link opened, with no conversation under it, as before", async () => {
    const app = await opened("/round", "/chats/photo/m1");
    await handOver("photo");
    expect(app.pathname()).toBe("/chats");
    expect(app.stack()).toEqual(["round", "chats/index"]);
  });

  it("leaves the list on the round after the conversation's own report, the conversation replaced", async () => {
    const app = await opened("/round", "/chats/c1");
    await handOver("conversation");
    expect(app.pathname()).toBe("/chats");
    expect(app.stack()).toEqual(["round", "chats/index"]);
    await act(async () => router.back());
    expect(app.pathname()).toBe("/round");
  });

  it("goes back down to the list after the conversation's own report when the list opened it", async () => {
    const app = await opened("/chats", "/chats/c1");
    await handOver("conversation");
    expect(app.pathname()).toBe("/chats");
    expect(app.stack()).toEqual(["chats/index"]);
  });
});
