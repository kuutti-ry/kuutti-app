import { INVITATION_CODE_PATTERN, normaliseInvitationCode } from "@kuutti/schema";
import { Hono } from "hono";
import type { Deps } from "../app.ts";
import type { AppEnv } from "../lib/env.ts";

/** Where everybody goes whose phone has no store of Kuutti's yet. */
export const SITE_URL = "https://kuutti.app/";

/**
 * One link for Kuutti (#574, ADR-044 §13): `/i` and `/i/{code}` send an
 * iPhone or iPad to the App Store, an Android phone to Play and anything else
 * to the website, by the User-Agent alone. The code is never looked up, so no
 * database is asked and every code gets the same answer; on Android it rides
 * to Play as the install referrer, which the app reads once the native batch
 * can (#184). A store's address is configuration, unset until its listing is
 * out (#193), and the website until then. No page, nothing kept: the request
 * line names the route, never the code (lib/logger.ts).
 */
export function invitationLinkRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { APP_STORE_URL, PLAY_STORE_URL } = deps.config;

  const where = (userAgent: string, code: string | undefined): string => {
    // An iPod's User-Agent says iPhone OS.
    if (/iPhone|iPad/.test(userAgent)) return APP_STORE_URL ?? SITE_URL;
    if (!/Android/.test(userAgent) || !PLAY_STORE_URL) return SITE_URL;
    const play = new URL(PLAY_STORE_URL);
    const normalised = code === undefined ? "" : normaliseInvitationCode(code);
    if (INVITATION_CODE_PATTERN.test(normalised)) play.searchParams.set("referrer", normalised);
    return play.toString();
  };

  for (const path of ["/i", "/i/:code"]) {
    app.get(path, (c) => {
      c.header("cache-control", "no-store");
      return c.redirect(where(c.req.header("user-agent") ?? "", c.req.param("code")), 302);
    });
  }

  return app;
}
