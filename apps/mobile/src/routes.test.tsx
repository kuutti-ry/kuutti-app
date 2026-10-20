import * as Sentry from "@sentry/react-native";
import { render, screen } from "@testing-library/react-native";
import type * as React from "react";
import RootLayout from "../app/_layout";
import { redirectSystemPath } from "../app/+native-intent";
import NotFoundRoute from "../app/+not-found";
import EmailRoute from "../app/account/email";
import AuthReturnRoute from "../app/auth";
import ConversationRoute from "../app/chats/[id]";
import ConversationsRoute from "../app/chats/index";
import ChatPhotoRoute from "../app/chats/photo/[messageId]";
import IndexRoute from "../app/index";
import OnboardingRoute from "../app/onboarding";
import PhotoZoomRoute from "../app/photos/[id]";
import PhotosRoute from "../app/photos/index";
// The slice boundary's glob matches any path with a `profile` segment; these
// are Expo Router's route files under app/, not the profile slice's internals.
// biome-ignore lint/style/noRestrictedImports: a route file, not a slice internal
import CardPreviewRoute from "../app/profile/card";
// biome-ignore lint/style/noRestrictedImports: a route file, not a slice internal
import DealBreakersRoute from "../app/profile/deal-breakers";
import ProfileRoute from "../app/profile/index";
// biome-ignore lint/style/noRestrictedImports: a route file, not a slice internal
import LaterFieldRoute from "../app/profile/later/[field]";
// biome-ignore lint/style/noRestrictedImports: a route file, not a slice internal
import ProfileSectionRoute from "../app/profile/section/[id]";
import RoundRoute from "../app/round";
import AccountSettingsRoute from "../app/settings/account";
import ConsentRoute from "../app/settings/consent/[kind]";
import ContactsSettingsRoute from "../app/settings/contacts";
import DeviceRoute from "../app/settings/device";
import EmailSettingsRoute from "../app/settings/email";
import FeedbackRoute from "../app/settings/feedback";
import SettingsRoute from "../app/settings/index";
import LanguageRoute from "../app/settings/language";
import LegalRoute from "../app/settings/legal/[kind]";
import LicensesRoute from "../app/settings/licenses";
import NotificationsSettingsRoute from "../app/settings/notifications";
import PhotoDescriptionsRoute from "../app/settings/photo-descriptions";
import SourceRoute from "../app/settings/source";
import ThemeRoute from "../app/settings/theme";
import TechRoute from "../app/tech";

// The route files of app/ (rules/layout.md: routes only, thin): each renders
// its slice's screen and hands it the route's params, with the defaults a
// missing or repeated param falls back to. Expo Router wants nothing but
// routes in app/, so their test lives here. The screens are stand-ins that
// show the props they were given; each slice tests its own screens.

// The stylesheet is NativeWind's, compiled by Metro; the test runner has no use for it.
jest.mock("../global.css", () => ({}));
jest.mock("@/features/identity", () => {
  const { createElement, Fragment } = require("react") as typeof import("react");
  const { Text } = require("react-native") as typeof import("react-native");
  const probe = (name: string) => (props: object) =>
    createElement(Text, { testID: name }, JSON.stringify(props));
  return {
    EmailScreen: probe("EmailScreen"),
    OnboardingScreen: probe("OnboardingScreen"),
    SignInScreen: probe("SignInScreen"),
    SignedOutToStart: probe("SignedOutToStart"),
    SessionProvider: ({ children }: { children: React.ReactNode }) =>
      createElement(Fragment, null, children),
  };
});
jest.mock("@/features/chat", () => {
  const { createElement, Fragment } = require("react") as typeof import("react");
  const { Text } = require("react-native") as typeof import("react-native");
  const probe = (name: string) => (props: object) =>
    createElement(Text, { testID: name }, JSON.stringify(props));
  return {
    ChatLiveProvider: ({ children }: { children: React.ReactNode }) =>
      createElement(Fragment, null, children),
    ChatPhotoScreen: probe("ChatPhotoScreen"),
    ConversationScreen: probe("ConversationScreen"),
    ConversationsScreen: probe("ConversationsScreen"),
  };
});
jest.mock("@/features/home", () => {
  const { createElement } = require("react") as typeof import("react");
  const { Text } = require("react-native") as typeof import("react-native");
  return {
    HomeRoute: (props: object) =>
      createElement(Text, { testID: "HomeRoute" }, JSON.stringify(props)),
  };
});
jest.mock("@/features/matching", () => {
  const { createElement } = require("react") as typeof import("react");
  const { Text } = require("react-native") as typeof import("react-native");
  return {
    RoundScreen: (props: object) =>
      createElement(Text, { testID: "RoundScreen" }, JSON.stringify(props)),
  };
});
jest.mock("@/features/media", () => {
  const { createElement } = require("react") as typeof import("react");
  const { Text } = require("react-native") as typeof import("react-native");
  const probe = (name: string) => (props: object) =>
    createElement(Text, { testID: name }, JSON.stringify(props));
  return { PhotosScreen: probe("PhotosScreen"), PhotoZoomScreen: probe("PhotoZoomScreen") };
});
jest.mock("@/features/profile", () => {
  const { createElement } = require("react") as typeof import("react");
  const { Text } = require("react-native") as typeof import("react-native");
  const probe = (name: string) => (props: object) =>
    createElement(Text, { testID: name }, JSON.stringify(props));
  return {
    CardPreviewScreen: probe("CardPreviewScreen"),
    DealBreakersScreen: probe("DealBreakersScreen"),
    holdLinkWhileUnsaved: jest.fn((path: string) => path),
    LaterFieldScreen: probe("LaterFieldScreen"),
    ProfileScreen: probe("ProfileScreen"),
    SectionScreen: probe("SectionScreen"),
  };
});
jest.mock("@/features/settings", () => {
  const { createElement } = require("react") as typeof import("react");
  const { Text } = require("react-native") as typeof import("react-native");
  const probe = (name: string) => (props: object) =>
    createElement(Text, { testID: name }, JSON.stringify(props));
  return {
    AccountScreen: probe("AccountScreen"),
    ConsentScreen: probe("ConsentScreen"),
    consentKindOf: (value: unknown) => (value === "special_category" ? value : "research"),
    ContactsSettingsScreen: probe("ContactsSettingsScreen"),
    NotificationsSettingsScreen: probe("NotificationsSettingsScreen"),
    DeviceScreen: probe("DeviceScreen"),
    EmailSettingsScreen: probe("EmailSettingsScreen"),
    FeedbackScreen: probe("FeedbackScreen"),
    LanguageScreen: probe("LanguageScreen"),
    LegalScreen: probe("LegalScreen"),
    legalKindOf: (value: unknown) => (value === "privacy" ? value : "terms"),
    LicensesScreen: probe("LicensesScreen"),
    PhotoDescriptionsScreen: probe("PhotoDescriptionsScreen"),
    ScreenReaderHint: probe("ScreenReaderHint"),
    SettingsScreen: probe("SettingsScreen"),
    SourceScreen: probe("SourceScreen"),
    TechConfigScreen: probe("TechConfigScreen"),
    ThemeScreen: probe("ThemeScreen"),
  };
});

/** The jest.setup.js stand-in for Expo Router, with what the route files need beyond it. */
const router = jest.requireMock("expo-router") as {
  useLocalSearchParams: () => Record<string, string | string[] | undefined>;
  Redirect?: (props: { href: string }) => React.ReactElement;
  Stack?: ((props: object) => React.ReactElement) & {
    Screen?: (props: object) => React.ReactElement;
  };
};
const params = (value: Record<string, string | readonly string[] | undefined>) => {
  router.useLocalSearchParams = () => value as Record<string, string | string[] | undefined>;
};
/** The props a stand-in screen was rendered with. */
const propsOf = (name: string) =>
  JSON.parse(String(screen.getByTestId(name).props.children)) as Record<string, unknown>;

beforeAll(() => {
  const { createElement } = require("react") as typeof import("react");
  const { Text } = require("react-native") as typeof import("react-native");
  router.Redirect = ({ href }) => createElement(Text, { testID: "Redirect" }, href);
  router.Stack = (props) => createElement(Text, { testID: "Stack" }, JSON.stringify(props));
  // A route's own screen options, beside its screen (the photos route, #179).
  router.Stack.Screen = (props) =>
    createElement(Text, { testID: "Stack.Screen" }, JSON.stringify(props));
});
beforeEach(() => params({}));

describe("the screens without params", () => {
  it.each([
    ["/", IndexRoute, "HomeRoute"],
    ["/account/email", EmailRoute, "EmailScreen"],
    ["/chats", ConversationsRoute, "ConversationsScreen"],
    ["/onboarding", OnboardingRoute, "OnboardingScreen"],
    ["/photos", PhotosRoute, "PhotosScreen"],
    ["/profile", ProfileRoute, "ProfileScreen"],
    ["/profile/card", CardPreviewRoute, "CardPreviewScreen"],
    ["/profile/deal-breakers", DealBreakersRoute, "DealBreakersScreen"],
    ["/round", RoundRoute, "RoundScreen"],
    ["/settings", SettingsRoute, "SettingsScreen"],
    ["/settings/account", AccountSettingsRoute, "AccountScreen"],
    ["/settings/contacts", ContactsSettingsRoute, "ContactsSettingsScreen"],
    ["/settings/notifications", NotificationsSettingsRoute, "NotificationsSettingsScreen"],
    ["/settings/device", DeviceRoute, "DeviceScreen"],
    ["/settings/email", EmailSettingsRoute, "EmailSettingsScreen"],
    ["/settings/feedback", FeedbackRoute, "FeedbackScreen"],
    ["/settings/language", LanguageRoute, "LanguageScreen"],
    ["/settings/licenses", LicensesRoute, "LicensesScreen"],
    ["/settings/source", SourceRoute, "SourceScreen"],
    ["/settings/theme", ThemeRoute, "ThemeScreen"],
    ["/settings/photo-descriptions", PhotoDescriptionsRoute, "PhotoDescriptionsScreen"],
    ["/tech", TechRoute, "TechConfigScreen"],
  ] as const)("%s renders its screen, with nothing to hand it", async (_path, Route, name) => {
    await render(<Route />);
    expect(propsOf(name)).toEqual({});
  });

  it("/photos turns the stack's back gesture off, so a drag to the right keeps the tile (#179)", async () => {
    await render(<PhotosRoute />);
    expect(propsOf("Stack.Screen")).toEqual({ options: { gestureEnabled: false } });
  });

  it("sends a link it has no screen for to the start", async () => {
    await render(<NotFoundRoute />);
    expect(screen.getByTestId("Redirect").props.children).toBe("/");
  });
});

describe("one conversation, /chats/[id]", () => {
  it.each([
    [
      "the id",
      { id: "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a70" },
      "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a70",
    ],
    ["the first of a repeated id", { id: ["a", "b"] }, "a"],
    ["nothing, without an id", {}, ""],
  ] as const)("hands the screen %s", async (_what, given, id) => {
    params(given);
    await render(<ConversationRoute />);
    expect(propsOf("ConversationScreen")).toEqual({ id });
  });
});

describe("a conversation's photo full size, /chats/photo/[messageId] (#350)", () => {
  const MESSAGE = "00000000-0000-4000-8000-000000000004";
  const CONVERSATION = "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a70";

  it("hands the screen the message, its conversation, its place as a number and its placeholder", async () => {
    params({ messageId: MESSAGE, conversation: CONVERSATION, seq: "4", blurhash: "LEHV6n" });
    await render(<ChatPhotoRoute />);
    expect(propsOf("ChatPhotoScreen")).toEqual({
      messageId: MESSAGE,
      conversation: CONVERSATION,
      seq: 4,
      blurhash: "LEHV6n",
    });
  });

  it("takes the first of a param that came twice", async () => {
    params({ messageId: [MESSAGE, "b"], conversation: [CONVERSATION, "d"], seq: ["7", "8"] });
    await render(<ChatPhotoRoute />);
    expect(propsOf("ChatPhotoScreen")).toEqual({
      messageId: MESSAGE,
      conversation: CONVERSATION,
      seq: 7,
      blurhash: "",
    });
  });

  it.each<Record<string, string | readonly string[]>>([
    {},
    { seq: "" },
    { seq: "four" },
    { seq: "1.5" },
    { seq: "0" },
    { seq: "-3" },
  ])("hands nothing and no place for %j, which no bubble sends", async (value) => {
    params(value);
    await render(<ChatPhotoRoute />);
    expect(propsOf("ChatPhotoScreen")).toEqual({
      messageId: "",
      conversation: "",
      seq: 0,
      blurhash: "",
    });
  });
});

describe("the bank login's return, /auth", () => {
  it("hands the code, the refusal and its date to the sign-in screen", async () => {
    params({ code: "c", error: "auth_cooldown", until: "2026-10-22" });
    await render(<AuthReturnRoute />);
    expect(propsOf("SignInScreen")).toEqual({
      code: "c",
      error: "auth_cooldown",
      until: "2026-10-22",
    });
  });

  it("takes the first of a param that came twice, and leaves out what did not come", async () => {
    params({ code: ["first", "second"] });
    await render(<AuthReturnRoute />);
    expect(propsOf("SignInScreen")).toEqual({ code: "first" });
  });
});

describe("the photos screen, /photos", () => {
  it("hands the onboarding's step as numbers when it opened the screen (#146)", async () => {
    params({ step: "8", total: "10" });
    await render(<PhotosRoute />);
    expect(propsOf("PhotosScreen")).toEqual({ progress: { step: 8, total: 10 } });
  });

  it.each<Record<string, string | readonly string[]>>([
    { step: "8" },
    { total: "10" },
    { step: "", total: "10" },
    { step: "eight", total: "10" },
    { step: "11", total: "10" },
    { step: "0", total: "10" },
    { step: "1.5", total: "10" },
    { step: ["8", "9"], total: "10" },
  ])("hands no step for %j, which no onboarding sends", async (value) => {
    params(value);
    await render(<PhotosRoute />);
    expect(propsOf("PhotosScreen")).toEqual({});
  });
});

describe("the zoom screen, /photos/[id]", () => {
  it("hands the photo, its placeholder and its place in the grid as numbers", async () => {
    params({ id: "p1", blurhash: "LEHV6n", position: "2", total: "3" });
    await render(<PhotoZoomRoute />);
    expect(propsOf("PhotoZoomScreen")).toEqual({
      id: "p1",
      blurhash: "LEHV6n",
      position: 2,
      total: 3,
      caption: null,
      description: null,
    });
  });

  it("hands the check's description through as the grid passed it, less a key this build cannot say; anything else is none (#296)", async () => {
    const description = {
      people: 1,
      setting: "outdoors",
      scene: ["lake"],
      objects: ["dog"],
      smile: true,
      glasses: false,
      sunglasses: false,
      facialHair: false,
    };
    const base = { id: "p1", blurhash: "LEHV6n", position: "1", total: "2" };
    params({ ...base, description: JSON.stringify(description) });
    await render(<PhotoZoomRoute />);
    expect(propsOf("PhotoZoomScreen")).toMatchObject({ description });
    params({
      ...base,
      description: JSON.stringify({ ...description, scene: ["lake", "volcano"] }),
    });
    await render(<PhotoZoomRoute />);
    expect(propsOf("PhotoZoomScreen")).toMatchObject({ description });
    for (const raw of ["not json", JSON.stringify({ people: "one" }), JSON.stringify(null), ""]) {
      params({ ...base, description: raw });
      await render(<PhotoZoomRoute />);
      expect(propsOf("PhotoZoomScreen")).toMatchObject({ description: null });
    }
  });

  it("hands the caption's key through, and anything else in the link is no caption (#296)", async () => {
    params({ id: "p1", blurhash: "LEHV6n", position: "1", total: "2", caption: "travelling" });
    await render(<PhotoZoomRoute />);
    expect(propsOf("PhotoZoomScreen")).toMatchObject({ caption: "travelling" });
    params({ id: "p1", blurhash: "LEHV6n", position: "1", total: "2", caption: "not a line" });
    await render(<PhotoZoomRoute />);
    expect(propsOf("PhotoZoomScreen")).toMatchObject({ caption: null });
  });

  it("falls back to no placeholder and one photo of one", async () => {
    params({ id: "p1" });
    await render(<PhotoZoomRoute />);
    expect(propsOf("PhotoZoomScreen")).toEqual({
      id: "p1",
      blurhash: "",
      position: 1,
      total: 1,
      caption: null,
      description: null,
    });
  });
});

describe("the profile's routes with a param", () => {
  it("hands a later field's key to its screen, and an empty one when the link has none", async () => {
    params({ field: "smoking" });
    const view = await render(<LaterFieldRoute />);
    expect(propsOf("LaterFieldScreen")).toEqual({ field: "smoking" });
    await view.unmount();
    params({});
    await render(<LaterFieldRoute />);
    expect(propsOf("LaterFieldScreen")).toEqual({ field: "" });
  });

  it.each([
    [
      "a consent's kind",
      ConsentRoute,
      "ConsentScreen",
      { kind: "special_category" },
      "special_category",
    ],
    [
      "a consent's kind, the first of two",
      ConsentRoute,
      "ConsentScreen",
      { kind: ["special_category", "research"] },
      "special_category",
    ],
    ["the research consent for a link naming none", ConsentRoute, "ConsentScreen", {}, "research"],
    [
      "a legal text's kind, the first of two",
      LegalRoute,
      "LegalScreen",
      { kind: ["privacy", "terms"] },
      "privacy",
    ],
    ["the terms for a link naming no text", LegalRoute, "LegalScreen", {}, "terms"],
  ] as const)("hands %s to its screen (#287)", async (_what, Route, name, given, kind) => {
    params({ ...given });
    await render(<Route />);
    expect(propsOf(name)).toEqual({ kind });
  });

  it("hands a section's id to its screen, and an empty one when the link has none", async () => {
    params({ id: "basics" });
    const view = await render(<ProfileSectionRoute />);
    expect(propsOf("SectionScreen")).toEqual({ section: "basics" });
    await view.unmount();
    params({});
    await render(<ProfileSectionRoute />);
    expect(propsOf("SectionScreen")).toEqual({ section: "" });
  });
});

describe("the root layout", () => {
  it("keeps error reporting off in a build without a DSN", () => {
    // _layout.tsx calls Sentry.init when it loads, with the options of src/lib/sentry.ts.
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, sendDefaultPii: false }),
    );
  });

  it("puts the stack without headers under the providers, with the signed-out watcher and the screen-reader hint beside it", async () => {
    await render(<RootLayout />);
    expect(propsOf("Stack")).toEqual({
      screenOptions: { headerShown: false, contentStyle: { backgroundColor: "transparent" } },
    });
    expect(screen.getByTestId("SignedOutToStart")).toBeTruthy();
    expect(screen.getByTestId("ScreenReaderHint")).toBeTruthy();
  });
});

describe("a link from outside the app", () => {
  it("passes through the hold on unsaved changes, cold start or not (#285)", () => {
    const { holdLinkWhileUnsaved } = jest.requireMock("@/features/profile") as {
      holdLinkWhileUnsaved: jest.Mock;
    };
    expect(redirectSystemPath({ path: "kuutti://settings", initial: true })).toBe(
      "kuutti://settings",
    );
    expect(holdLinkWhileUnsaved).toHaveBeenLastCalledWith("kuutti://settings", true);
    expect(redirectSystemPath({ path: "kuutti://", initial: false })).toBe("kuutti://");
    expect(holdLinkWhileUnsaved).toHaveBeenLastCalledWith("kuutti://", false);
  });
});
