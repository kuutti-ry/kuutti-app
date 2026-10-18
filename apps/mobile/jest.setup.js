// Reanimated 4 and its worklets runtime are native; in jest they run as the
// mocks the two packages ship (#12).
jest.mock("react-native-worklets", () => require("react-native-worklets/lib/module/mock"));
require("react-native-reanimated").setUpTests();

// The device's languages and the preference store are native; tests set them
// through these mocks (src/features/smoke/language.test.tsx) and start from an English phone
// with nothing stored.
jest.mock("expo-localization", () => ({
  useLocales: jest.fn(() => [{ languageTag: "en-US" }]),
}));
jest.mock("expo-secure-store", () => {
  const store = new Map();
  return {
    __store: store,
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
    getItemAsync: jest.fn(async (key) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key, value) => void store.set(key, value)),
    deleteItemAsync: jest.fn(async (key) => void store.delete(key)),
  };
});

// The Sentry SDK is native and ships ESM; tests get a stand-in and can assert
// on what was reported (never the stored value, only the error).
jest.mock("@sentry/react-native", () => ({
  init: jest.fn(),
  wrap: (component) => component,
  captureException: jest.fn(),
}));

// Expo Router's navigation is native-backed; tests see one router object they
// can assert on (src/features/identity/SignInScreen.test.tsx) and no params.
// A screen in a test has the focus from the start, and `__focus()` gives it
// the focus again, as coming back to it does (src/features/pond/GateCard.test.tsx);
// `__blur()` takes it away, as another screen opening over it does
// (src/features/chat/ConversationScreen.test.tsx).
// The navigation object a screen listens on; `__navigation.emit("beforeRemove", event)`
// is a test leaving the screen (the profile section saves on it, #238), and
// `setOptions` records what a screen sets on its route (the swipe, off while unsaved).
// Several screens may listen at once (one under another, ConfirmLeave.test.tsx),
// each removing only its own listener.
const mockNavigationListeners = new Map();
const mockNavigation = {
  addListener: jest.fn((name, listener) => {
    if (!mockNavigationListeners.has(name)) mockNavigationListeners.set(name, new Set());
    mockNavigationListeners.get(name).add(listener);
    return () => mockNavigationListeners.get(name)?.delete(listener);
  }),
  dispatch: jest.fn(),
  setOptions: jest.fn(),
  emit: (name, event) => {
    for (const listener of mockNavigationListeners.get(name) ?? []) listener(event);
  },
};
jest.mock("expo-router", () => {
  const { useEffect } = require("react");
  const router = {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    dismissTo: jest.fn(),
    setParams: jest.fn(),
  };
  // Each focus effect with the cleanup of its latest run.
  const focused = new Map();
  return {
    __router: router,
    __navigation: mockNavigation,
    __navigationListeners: mockNavigationListeners,
    useNavigation: () => mockNavigation,
    __focus: () => {
      for (const effect of focused.keys()) focused.set(effect, effect());
    },
    __blur: () => {
      for (const [effect, cleanup] of focused) {
        if (typeof cleanup === "function") cleanup();
        focused.set(effect, undefined);
      }
    },
    useRouter: () => router,
    useLocalSearchParams: () => ({}),
    useFocusEffect: (effect) =>
      useEffect(() => {
        focused.set(effect, effect());
        return () => {
          const cleanup = focused.get(effect);
          focused.delete(effect);
          if (typeof cleanup === "function") cleanup();
        };
      }, [effect]),
  };
});

// The phone's photo picker and the image manipulator are native (#48). The
// picker cancels unless a test says otherwise; the manipulator "resizes" by
// returning the requested size and a new uri, so a test can see the picture
// went through the pre-resize before the upload.
// The export's hand-over (#237): files written to a fake cache, a picker a
// test can resolve or cancel. What a test needs to see is on __files.
jest.mock("expo-file-system", () => {
  const files = new Map();
  class File {
    constructor(...parts) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    write(content) {
      files.set(this.uri, content);
    }
    delete() {
      files.delete(this.uri);
    }
  }
  class Directory {
    constructor(uri) {
      this.uri = uri;
    }
    createFile(name) {
      return new File(this, name);
    }
  }
  Directory.pickDirectoryAsync = jest.fn(async () => new Directory("content://picked"));
  return { Directory, File, Paths: { cache: new Directory("file:///cache") }, __files: files };
});
jest.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: null })),
}));
jest.mock("expo-image-manipulator", () => {
  const manipulate = jest.fn((uri) => {
    let size = { width: 3000, height: 2000 };
    const context = {
      resize: jest.fn((wanted) => {
        const ratio = size.width / size.height;
        size = wanted.width
          ? { width: wanted.width, height: Math.round(wanted.width / ratio) }
          : { width: Math.round(wanted.height * ratio), height: wanted.height };
        return context;
      }),
      renderAsync: jest.fn(async () => ({
        ...size,
        saveAsync: jest.fn(async () => ({ uri: `${uri}#resized`, ...size })),
      })),
    };
    return context;
  });
  return {
    ImageManipulator: { manipulate },
    SaveFormat: { JPEG: "jpeg", PNG: "png", WEBP: "webp" },
  };
});
