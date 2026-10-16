import { expect, it, vi } from "vitest";

// The host's CSP has no 'unsafe-eval' (ADR-025 §3), and a browser reports even
// a `new Function` that the caller catches. zod probes for it when the first
// object schema is built, at the moment @kuutti/schema is evaluated, so the
// order of main.tsx's imports is what decides it: loaded as the page loads it,
// the panel builds no function from a string. A test file is a worker of its
// own, so zod is evaluated here for the first time.

it("builds no function from a string while the panel loads", async () => {
  const built: string[] = [];
  const RealFunction = globalThis.Function;
  globalThis.Function = new Proxy(RealFunction, {
    apply(target, self, args) {
      built.push(args.join(", "));
      return Reflect.apply(target, self, args);
    },
    construct(target, args) {
      built.push(args.join(", "));
      return Reflect.construct(target, args);
    },
  });
  const element = document.createElement("div");
  element.id = "root";
  document.body.append(element);
  // The signed-out panel asks the API for its health only; the answer never comes.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => undefined)),
  );
  try {
    await import("./main.tsx");
  } finally {
    globalThis.Function = RealFunction;
  }
  expect(built).toEqual([]);
  // And it is the panel that loaded: the sign-in is on the page.
  await vi.waitFor(() => expect(element.querySelector("#sign-in-title")).not.toBeNull());
});
