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
// the focus again, as coming back to it does (src/features/pond/GateCard.test.tsx).
jest.mock("expo-router", () => {
  const { useEffect } = require("react");
  const router = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), setParams: jest.fn() };
  const focused = new Set();
  // The navigation object a screen listens on (beforeRemove, the unsaved-changes
  // guard of the profile screen); `__navigation.emit(name, event)` is a test leaving the screen.
  const listeners = new Map();
  const navigation = {
    addListener: jest.fn((name, listener) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    }),
    dispatch: jest.fn(),
    emit: (name, event) => listeners.get(name)?.(event),
  };
  return {
    __router: router,
    __navigation: navigation,
    useNavigation: () => navigation,
    __focus: () => {
      for (const effect of focused) effect();
    },
    useRouter: () => router,
    useLocalSearchParams: () => ({}),
    useFocusEffect: (effect) =>
      useEffect(() => {
        focused.add(effect);
        const cleanup = effect();
        return () => {
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
