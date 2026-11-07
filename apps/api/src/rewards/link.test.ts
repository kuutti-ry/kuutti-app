import { createApp } from "../app.ts";
import { captureLogger, describe, expect, test, testConfig } from "../test/harness.ts";
import { hashOf, invitationOf } from "../test/invitations.ts";
import { people } from "../test/people.ts";
import { SITE_URL } from "./link.ts";

// The one link (#574, ADR-044 §13): a phone goes to its own store by the
// User-Agent, anything else to the website, and the code is never looked up.

const APP_STORE = "https://apps.apple.com/app/id6700000000";
const PLAY = "https://play.google.com/store/apps/details?id=fi.kuutti.app";
const STORES = { APP_STORE_URL: APP_STORE, PLAY_STORE_URL: PLAY };

const UA = {
  iPhone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  iPad: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  iPod: "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  android:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  desktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
};

async function appWith(ctx: { client: Parameters<typeof createApp>[0]["db"] }, overrides = {}) {
  const captured = await captureLogger();
  const app = createApp({ config: testConfig(overrides), logger: captured.logger, db: ctx.client });
  return { app, lines: captured.lines };
}

async function follow(app: Awaited<ReturnType<typeof appWith>>["app"], path: string, ua?: string) {
  const res = await app.request(path, { headers: ua === undefined ? {} : { "user-agent": ua } });
  return { status: res.status, location: res.headers.get("location"), res };
}

describe("the one link", () => {
  test.for([
    ["an iPhone", UA.iPhone, APP_STORE],
    ["an iPad that says so", UA.iPad, APP_STORE],
    ["an iPod, whose User-Agent says iPhone OS", UA.iPod, APP_STORE],
    ["an Android phone", UA.android, PLAY],
    ["a computer", UA.desktop, SITE_URL],
    ["a caller that names nothing", undefined, SITE_URL],
  ] as const)("/i sends %s to its place, uncached", async ([, ua, place], { ctx }) => {
    const { app } = await appWith(ctx, STORES);
    const { status, location, res } = await follow(app, "/i", ua);
    expect(status).toBe(302);
    expect(location).toBe(place);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });

  test("an Android phone takes the code to Play as the install referrer, as the API reads a code", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, STORES);
    const { location } = await follow(app, "/i/abcde-fghjk", UA.android);
    const url = new URL(location ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://play.google.com/store/apps/details");
    expect(url.searchParams.get("id")).toBe("fi.kuutti.app");
    expect(url.searchParams.get("referrer")).toBe("ABCDEFGHJK");
  });

  test.for([
    ["too short", "ABCDE"],
    ["too long", "ABCDE-FGHJK-M"],
    ["a letter Crockford leaves out", "ABCDE-FGHJU"],
  ] as const)(
    "a path that is no code (%s) goes to Play with no referrer",
    async ([, path], { ctx }) => {
      const { app } = await appWith(ctx, STORES);
      const { status, location } = await follow(app, `/i/${path}`, UA.android);
      expect(status).toBe(302);
      expect(location).toBe(PLAY);
    },
  );

  test("an iPhone and a computer get the same place with a code as without", async ({ ctx }) => {
    const { app } = await appWith(ctx, STORES);
    expect((await follow(app, "/i/ABCDE-FGHJK", UA.iPhone)).location).toBe(APP_STORE);
    expect((await follow(app, "/i/ABCDE-FGHJK", UA.desktop)).location).toBe(SITE_URL);
  });

  test("with no listing yet every phone goes to the website", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    for (const ua of [UA.iPhone, UA.android]) {
      expect((await follow(app, "/i/ABCDE-FGHJK", ua)).location).toBe(SITE_URL);
    }
  });

  test("a code that is somebody's invitation is answered as one that is nobody's", async ({
    ctx,
  }) => {
    const [inviter] = await people(ctx.client, null, 1);
    await invitationOf(ctx.client, inviter as string, { codeHash: hashOf("ABCDEFGHJK") });
    const { app } = await appWith(ctx, STORES);
    const real = new URL((await follow(app, "/i/ABCDE-FGHJK", UA.android)).location ?? "");
    const none = new URL((await follow(app, "/i/ZZZZZ-ZZZZZ", UA.android)).location ?? "");
    expect(real.searchParams.get("referrer")).toBe("ABCDEFGHJK");
    expect(none.searchParams.get("referrer")).toBe("ZZZZZZZZZZ");
    real.searchParams.delete("referrer");
    none.searchParams.delete("referrer");
    expect(real.toString()).toBe(none.toString());
  });

  test("the request's log line names the route, never the code", async ({ ctx }) => {
    const { app, lines } = await appWith(ctx, STORES);
    await follow(app, "/i/ABCDE-FGHJK", UA.android);
    const logged = JSON.stringify(lines());
    expect(logged).toContain("/i/:code");
    expect(logged).not.toMatch(/ABCDE|FGHJK/);
  });
});

describe("the stores' addresses", () => {
  test.for([
    ["APP_STORE_URL", "http://apps.apple.com/app/id1"],
    ["PLAY_STORE_URL", "not an address"],
  ] as const)("%s refuses anything but https", ([key, value]) => {
    expect(() => testConfig({ [key]: value })).toThrow(key);
  });
});
