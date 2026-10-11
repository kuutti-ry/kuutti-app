import { apiBaseUrl } from "./api-url";

// Where the app sends its requests (rules/mobile.md Auth and network): the
// build's EXPO_PUBLIC_API_URL first, then the Metro host in local dev, and a
// release build that names nothing, or plain http, refuses to start talking.

const mockConstants: { expoConfig: { hostUri?: string } | null } = { expoConfig: null };
jest.mock("expo-constants", () => ({
  __esModule: true,
  get default() {
    return mockConstants;
  },
}));

const globals = globalThis as unknown as { __DEV__: boolean };
const original = { dev: globals.__DEV__, url: process.env.EXPO_PUBLIC_API_URL };

function build({ dev, url, hostUri }: { dev: boolean; url?: string; hostUri?: string }) {
  globals.__DEV__ = dev;
  if (url === undefined) delete process.env.EXPO_PUBLIC_API_URL;
  else process.env.EXPO_PUBLIC_API_URL = url;
  mockConstants.expoConfig = hostUri === undefined ? null : { hostUri };
}

afterEach(() => {
  globals.__DEV__ = original.dev;
  if (original.url === undefined) delete process.env.EXPO_PUBLIC_API_URL;
  else process.env.EXPO_PUBLIC_API_URL = original.url;
  mockConstants.expoConfig = null;
});

describe("apiBaseUrl", () => {
  it("takes the build's address, without a trailing slash, over the Metro host", () => {
    build({ dev: true, url: "https://api.example.test/", hostUri: "192.168.1.20:8081" });
    expect(apiBaseUrl()).toBe("https://api.example.test");
  });

  it("lets a dev build talk plain http to the address it was given", () => {
    build({ dev: true, url: "http://10.0.2.2:3000" });
    expect(apiBaseUrl()).toBe("http://10.0.2.2:3000");
  });

  it("takes an https address in a release build", () => {
    build({ dev: false, url: "https://api.example.test" });
    expect(apiBaseUrl()).toBe("https://api.example.test");
  });

  it("refuses plain http in a release build: tokens travel in the header", () => {
    build({ dev: false, url: "http://api.example.test" });
    expect(() => apiBaseUrl()).toThrow("EXPO_PUBLIC_API_URL must be https in a release build");
  });

  it("derives the API on port 3000 of the Metro host in local dev", () => {
    build({ dev: true, hostUri: "192.168.1.20:8081" });
    expect(apiBaseUrl()).toBe("http://192.168.1.20:3000");
  });

  it("falls back to localhost in a dev build that knows no host", () => {
    build({ dev: true });
    expect(apiBaseUrl()).toBe("http://localhost:3000");
    build({ dev: true, hostUri: "" });
    expect(apiBaseUrl()).toBe("http://localhost:3000");
  });

  it("refuses a release build that names no address rather than talk to nothing", () => {
    build({ dev: false });
    expect(() => apiBaseUrl()).toThrow("EXPO_PUBLIC_API_URL is not set for this build");
  });
});
