import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// #360: on a cold start ScreensModule registers its screen-removal listener
// from two threads at once (the module's initialize() and the onHostResume()
// that registering for lifecycle events posts to the UI thread). 4.26.2 makes
// that listener lazily without a lock; the two shared_ptr writes tear, React
// Native keeps a delegate that points at freed memory, and the next
// MountingCoordinator::pullTransaction calls through it: SIGSEGV on the JS
// thread. react-native-screens 4.28.0 fixed it (software-mansion/
// react-native-screens#4413); Expo SDK 57 pins ~4.26, so the fix is patched
// onto 4.26.2 (patches/react-native-screens@4.26.2.patch). The race cannot be
// made to happen on demand, so this holds the installed native source to the
// fix instead; it passes on any release that carries it.
const proxy = readFileSync(
  join(
    dirname(require.resolve("react-native-screens/package.json")),
    "android/src/main/cpp/NativeProxy.cpp",
  ),
  "utf8",
);

describe("react-native-screens' screen-removal listener on Android (#360)", () => {
  it("is one listener for the process, made thread-safely, never lazily per module", () => {
    expect(proxy).not.toContain("if (!screenRemovalListener_)");
    expect(proxy).toContain("static const std::shared_ptr<RNSScreenRemovalListener> instance");
  });

  it("calls into Java through its own reference, never through a module that may be gone", () => {
    expect(proxy).not.toContain("[this](int tag)");
    expect(proxy).toContain("[javaPart = javaPart_](int tag)");
  });
});
