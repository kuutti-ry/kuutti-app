import { ErrorResponse } from "@kuutti/schema";
import { Hono } from "hono";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { captureLogger, test, testConfig } from "../test/harness.ts";
import type { AppEnv } from "./env.ts";
import { AppError } from "./errors.ts";
import { isLocalisedErrorCode, requestLocale, servedLocales, tFor, tOf } from "./i18n.ts";

describe("localised responses", () => {
  test("an API error response for a request with Accept-Language: fi carries the Finnish message", async ({
    ctx,
  }) => {
    const res = await ctx.app.request("/nope", { headers: { "accept-language": "fi" } });
    expect(res.status).toBe(404);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error).toMatchObject({ code: "not_found", message: "Ei löytynyt." });
    expect(res.headers.get("content-language")).toBe("fi");
    expect(res.headers.get("vary")).toContain("Accept-Language");
  });

  test("the code is the same in every language; only the message follows the header", async ({
    ctx,
  }) => {
    const messages = new Map<string, string>();
    for (const header of ["en", "fi-FI,fi;q=0.9,en;q=0.5", "sv", "de"]) {
      const res = await ctx.app.request("/nope", { headers: { "accept-language": header } });
      const body = ErrorResponse.parse(await res.json());
      expect(body.error.code).toBe("not_found");
      messages.set(header, body.error.message);
    }
    expect(Object.fromEntries(messages)).toEqual({
      en: "Not found.",
      "fi-FI,fi;q=0.9,en;q=0.5": "Ei löytynyt.",
      sv: "Hittades inte.",
      de: "Not found.",
    });
  });

  test("production serves the released languages only: Swedish falls to the next preference, or English", async ({
    ctx,
  }) => {
    expect(servedLocales("production")).toEqual(["en", "fi"]);
    expect(servedLocales("staging")).toEqual(["en", "fi", "sv", "fi-x-stadi"]);
    expect(servedLocales("preview")).toEqual(["en", "fi", "sv", "fi-x-stadi"]);
    const production = new Hono<AppEnv>();
    production.use("*", requestLocale(servedLocales("production")));
    production.get("/x", (c) => c.text("ok"));
    const language = async (header: string) =>
      (await production.request("/x", { headers: { "accept-language": header } })).headers.get(
        "content-language",
      );
    expect(await language("sv")).toBe("en");
    expect(await language("sv-FI,fi;q=0.8")).toBe("fi");
    expect(await language("fi")).toBe("fi");
    // Staging and previews keep all three, so a reviewer can read Swedish there.
    const res = await ctx.app.request("/nope", { headers: { "accept-language": "sv" } });
    expect(res.headers.get("content-language")).toBe("sv");
  });

  test("a request naming Stadi is answered in Finnish everywhere: nothing the API says is in slang (#521)", async ({
    ctx,
  }) => {
    const res = await ctx.app.request("/nope", { headers: { "accept-language": "fi-x-stadi" } });
    expect(res.headers.get("content-language")).toBe("fi");
    const body = ErrorResponse.parse(await res.json());
    expect(body.error.message).toBe("Ei löytynyt.");
    const production = new Hono<AppEnv>();
    production.use("*", requestLocale(servedLocales("production")));
    production.get("/x", (c) => c.text("ok"));
    const answer = await production.request("/x", { headers: { "accept-language": "fi-x-stadi" } });
    expect(answer.headers.get("content-language")).toBe("fi");
  });

  test("no header: English", async ({ ctx }) => {
    const res = await ctx.app.request("/nope");
    expect(ErrorResponse.parse(await res.json()).error.message).toBe("Not found.");
    expect(res.headers.get("content-language")).toBe("en");
  });

  test("an unhandled error is localised and still says nothing about its cause", async ({
    ctx,
  }) => {
    ctx.app.get("/boom", () => {
      throw new Error("relation accounts does not exist");
    });
    const res = await ctx.app.request("/boom", { headers: { "accept-language": "fi" } });
    expect(res.status).toBe(500);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error.message).toBe("Jokin meni vikaan meidän päässämme.");
    expect(JSON.stringify(body)).not.toContain("accounts");
  });

  test("an AppError code without a catalogue message keeps the route's own message", async ({
    ctx,
  }) => {
    ctx.app.get("/teapot", () => {
      throw new AppError(418, "teapot", "I am a teapot");
    });
    const res = await ctx.app.request("/teapot", { headers: { "accept-language": "fi" } });
    expect(ErrorResponse.parse(await res.json()).error).toMatchObject({
      code: "teapot",
      message: "I am a teapot",
    });
  });

  test("the rate limit answers in the request's language with the seconds left, as an ICU plural", async () => {
    const { logger } = await captureLogger();
    const app = createApp({
      config: testConfig({ RATE_LIMIT_PER_MINUTE: "1" }),
      logger,
      db: { query: () => Promise.reject(new Error("no database in this test")) },
    });
    const headers = { "accept-language": "fi", "x-forwarded-for": "203.0.113.7" };
    await app.request("/nope", { headers });
    const res = await app.request("/nope", { headers });
    expect(res.status).toBe(429);
    const seconds = Number(res.headers.get("retry-after"));
    expect(ErrorResponse.parse(await res.json()).error.message).toBe(
      `Liian monta pyyntöä. Yritä uudelleen ${seconds} sekunnin kuluttua.`,
    );
  });

  test("an unknown key is a type error in the API too", () => {
    const probe = (t: import("@kuutti/i18n").TFunction) => {
      // Compile-time assertion: tsc fails on an unused @ts-expect-error.
      // @ts-expect-error not a key of messages.yaml
      t("does.not.exist");
    };
    expect(probe).toBeTypeOf("function");
  });
});

describe("the request's language where the middleware has or has not run", () => {
  test("tOf follows the locale middleware, and falls back to English without it", async () => {
    const seen = (app: Hono<AppEnv>) =>
      app.get("/x", (c) => c.json({ text: tOf(c)("errors.not_found") }));
    const localised = new Hono<AppEnv>();
    localised.use("*", requestLocale());
    seen(localised);
    const bare = new Hono<AppEnv>();
    seen(bare);

    const fi = { headers: { "accept-language": "fi" } };
    expect(await (await localised.request("/x", fi)).json()).toEqual({ text: "Ei löytynyt." });
    // A bare app (a test, a tool) has no locale: English, whatever the header says.
    expect(await (await bare.request("/x", fi)).json()).toEqual({ text: "Not found." });
  });

  test("only a key of the catalogue's own is a localised code, never one an object inherits", () => {
    expect(isLocalisedErrorCode("not_found")).toBe(true);
    expect(isLocalisedErrorCode("consent_required")).toBe(true);
    for (const code of ["teapot", "toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(isLocalisedErrorCode(code), code).toBe(false);
    }
  });
});

// A push is worded in the language its device registered in (#102, ADR-055 §1).
describe("a stored language's t()", () => {
  test.each([
    ["en", "You have a new message", "You have a new match", "Today's round is ready"],
    ["fi", "Sinulle on uusi viesti", "Sinulle on uusi mätsi", "Päivän kierros on valmis"],
    ["sv", "Du har ett nytt meddelande", "Du har en ny matchning", "Dagens omgång är klar"],
  ])("tFor(%j) words the pushes in it", (locale, message, match, round) => {
    const t = tFor(locale);
    expect([t("push.message"), t("push.match"), t("push.round")]).toEqual([message, match, round]);
  });

  test.each(["de", "", "FI", "fi-FI", "en-XA", "toString", "__proto__"])(
    "a value that is not one of ours, %j, is English",
    (locale) => {
      expect(tFor(locale)("push.message")).toBe("You have a new message");
    },
  );
});
