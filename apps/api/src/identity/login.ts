import { randomBytes } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import type { AuthCallbackQuery, AuthExchangeResponse, AuthPlatform } from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import { ADMIN_PLATFORM, completeAdminLogin } from "./admin-session.ts";
import { BrokerError, type BrokerIdentity, type IdentityBroker } from "./broker.ts";
import {
  AUTH_REQUEST_CAP,
  AUTH_REQUEST_TTL_MS,
  appReturnUrl,
  hashOneTimeCode,
  newOneTimeCode,
  ONE_TIME_CODE_TTL_MS,
} from "./codes.ts";
import { deriveIdentity, InvalidHetuError } from "./hetu.ts";
import { resumeAccount } from "./pause.ts";
import { decideRegistration } from "./registration.ts";
import * as repo from "./repo.ts";

/**
 * How much earlier than the attempt's own start an `auth_time` may read and
 * still be this login (ADR-016). The broker's clock and the database's are
 * both disciplined by NTP and differ by seconds; a reused web session is
 * minutes or hours old.
 */
const AUTH_TIME_TOLERANCE_MS = 2 * 60_000;

export type LoginDeps = {
  db: Queryable;
  broker: IdentityBroker;
  hmacKey: Buffer;
  now: () => Date;
  /** Bound to the request (its id is in it): a login leaves one line, method and decision, nothing of the person. */
  logger: Logger;
  /** Where an admin login's browser is sent back to (#49). */
  adminAppUrl: string;
};

/**
 * /auth/start, and /admin/auth/start with the staff platform: remember state
 * and nonce, send the browser to the bank chooser. The attempt is written only
 * while auth_request has room (ADR-026 §6). At the ceiling the expired rows go
 * first; if the table is still full, the two oldest attempts the bank has not
 * answered yet give way to this one, so a flood shortens how long an
 * unanswered attempt lives rather than shutting the door on everybody. Only a
 * table whose every row the bank has answered, each holding a code or a
 * callback under way, refuses a start, before the broker signs anything;
 * nobody keeps such a row without the bank, since a callback the bank does
 * not complete ends its attempt at once (ADR-026 §8). `cap` is the ceiling;
 * tests make it small. The app's attempt carries the SHA-256 of its verifier,
 * which its exchange must present; it is null only for staff (ADR-027).
 */
export async function startLogin(
  deps: LoginDeps,
  input: {
    platform: AuthPlatform | typeof ADMIN_PLATFORM;
    locale: string | null;
    codeChallenge: string | null;
  },
  cap = AUTH_REQUEST_CAP,
): Promise<URL> {
  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  const now = deps.now();
  const attempt = {
    state,
    nonce,
    platform: input.platform,
    locale: input.locale,
    expiresAt: new Date(now.getTime() + AUTH_REQUEST_TTL_MS),
    codeChallenge: input.codeChallenge,
  };
  let written = await repo.insertAuthRequest(deps.db, attempt, cap);
  // The table is counted again only when the sweep freed something.
  if (!written && (await repo.deleteExpiredAuthRequests(deps.db, now)) > 0) {
    written = await repo.insertAuthRequest(deps.db, attempt, cap);
  }
  if (!written) {
    // The eviction and the insert are one statement, so no other start can
    // take the room it makes.
    const evicted = await repo.evictAndInsertAuthRequest(deps.db, attempt);
    if (evicted === 0) {
      throw new AppError(429, "auth_rate_limited", "Too many logins are under way");
    }
    // A person whose attempt it ended meets auth_state_mismatch at the
    // callback; an attempt whose callback has come back is never taken
    // (ADR-026 §8). The line is the runbook's signal that the table is full
    // (ADR-026 §7): this start goes on, so no refusal of it would show.
    deps.logger.warn({ detail: { limiter: "evicted", evicted } }, "sign-in refused");
  }
  return deps.broker.startLogin({ state, nonce, locale: input.locale });
}

const attemptGone = (detail?: { platform: typeof ADMIN_PLATFORM }) =>
  new AppError(400, "auth_state_mismatch", "This login attempt is unknown or has expired", detail);

/**
 * /auth/callback: the bank has answered. The hetu exists inside this function
 * only (rule 1): it is derived into hetu_hmac and the age and then dropped
 * with the broker's result. The re-registration rule decides what the login
 * is; a refusal is counted on the identity; a success leaves a one-time code
 * for the app to exchange, and the browser is sent to the app's deep link.
 * A state is answered once (#324, ADR-026 §8).
 */
export async function completeLogin(
  deps: LoginDeps,
  input: { callbackUrl: URL; query: AuthCallbackQuery },
): Promise<URL> {
  const now = deps.now();
  // The attempt is spent in the statement that finds it, before the broker is
  // asked anything, so a replay of this return, at once or later, costs no
  // token call; the claim's deadline keeps the eviction and the sweep off it
  // while the bank answers.
  const request = await repo.claimAuthRequest(deps.db, {
    state: input.query.state,
    now,
    until: new Date(now.getTime() + AUTH_REQUEST_TTL_MS),
  });
  if (!request) {
    // A state the claim did not take, used, under way or expired, is still
    // its attempt's row, which says where the browser belongs: a staff
    // attempt's goes back to the panel (#250). Only a state no row holds,
    // never written, evicted or swept, lands on the app's link.
    const platform = await repo.findAuthRequestPlatform(deps.db, input.query.state);
    throw attemptGone(platform === ADMIN_PLATFORM ? { platform: ADMIN_PLATFORM } : undefined);
  }
  try {
    return await finishLogin(deps, input, request, now);
  } catch (error) {
    // A 500 keeps its claim until the deadline, and its own error reaches the
    // error sink unmasked.
    if (!(error instanceof AppError)) throw error;
    // A refused or failed callback ends its attempt there and then: the mark
    // keeps refusing a replay, and the row is the sweep's, not one the
    // eviction must skip until its deadline (ADR-026 §6, §8).
    await repo.expireAuthRequest(deps.db, request.id, now);
    // From here the attempt is known, and so is where its browser belongs: a
    // refusal of a staff attempt (#49) carries the platform, so the route
    // sends the browser to the panel, not to the app.
    if (request.platform === ADMIN_PLATFORM) {
      throw new AppError(error.status, error.code, error.message, {
        ...(typeof error.detail === "object" && error.detail !== null ? error.detail : {}),
        platform: ADMIN_PLATFORM,
      });
    }
    throw error;
  }
}

async function finishLogin(
  deps: LoginDeps,
  input: { callbackUrl: URL; query: AuthCallbackQuery },
  request: NonNullable<Awaited<ReturnType<typeof repo.claimAuthRequest>>>,
  now: Date,
): Promise<URL> {
  if (input.query.error) {
    // The person backed out at the bank (guide 2.5.2: access_denied, no code):
    // not a failure of anything. Any other code reaches the log (OAuth codes
    // are snake_case words); free text does not.
    if (input.query.error === "access_denied") {
      // The attempt is over, as every refusal's is (completeLogin): its state
      // cannot be completed with a code later.
      throw new AppError(400, "auth_cancelled", "The person cancelled at the bank");
    }
    const code = /^[a-z_]+$/.test(input.query.error) ? input.query.error : "unnamed error";
    throw new BrokerError(`broker answered ${code}`);
  }

  const derived = await deriveFromBroker(deps, input.callbackUrl, request, now);
  // ADR-016: the request object asks for the bank every time (prompt=login),
  // so the authentication the broker reports happened after this attempt
  // began. One that predates it is a web session reused for somebody else, or
  // a broker that ignored the ask; either way it is no login of this person.
  if (
    derived.reference.authenticatedAt.getTime() <
    request.createdAt.getTime() - AUTH_TIME_TOLERANCE_MS
  ) {
    throw new BrokerError("authentication predates this login attempt");
  }
  if (!derived.adult) {
    throw new AppError(403, "auth_under_18", "Kuutti is for adults only");
  }

  // A staff login (#49) resolves to an identity with a role and creates nothing.
  if (request.platform === ADMIN_PLATFORM) {
    return completeAdminLogin(deps, {
      request,
      hetuHmac: derived.hetuHmac,
      reference: derived.reference,
      now,
    });
  }

  // The account can be erased (#51) between its resolution and the code: the
  // attach then writes nothing, the attempt is still there, and resolving
  // again reads the cooldown the erasure recorded, so the browser leaves with
  // auth_cooldown, not a code.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { accountId, outcome } = await resolveAccount(deps, derived, now);
    const { code, hash } = newOneTimeCode();
    const attached = await repo.attachCode(deps.db, {
      id: request.id,
      codeHash: hash,
      codeExpiresAt: new Date(now.getTime() + ONE_TIME_CODE_TTL_MS),
      accountId,
      outcome,
    });
    if (attached) {
      // The one line a login leaves (#33): the level, the method as the broker
      // names it, and what was decided. No claim, no code, no token.
      deps.logger.info(
        { acr: derived.reference.acr, amr: derived.reference.amr, outcome },
        "bank login",
      );
      return new URL(appReturnUrl(code));
    }
  }
  throw new Error("account erased twice during one login");
}

type Derived = Awaited<ReturnType<typeof deriveFromBroker>>;

/**
 * The re-registration rule applied and acted on. Two logins of the same
 * person can run at once (two devices): when this one loses the insert of the
 * identity, the rule is applied once more against the row the other created,
 * which then reads as a resume.
 */
async function resolveAccount(
  deps: LoginDeps,
  derived: Derived,
  now: Date,
): Promise<{ accountId: string; outcome: AuthExchangeResponse["outcome"] }> {
  for (let attempt = 0; ; attempt++) {
    const identity = await repo.findIdentityByHmac(deps.db, derived.hetuHmac);
    const liveAccount = identity ? await repo.findLiveAccount(deps.db, identity.id) : null;
    const decision = decideRegistration({ identity, liveAccount, now });

    switch (decision.kind) {
      case "refuse": {
        if (identity) await repo.countRefusedAttempt(deps.db, identity.id);
        if (decision.reason === "cooldown") {
          throw new AppError(403, "auth_cooldown", "A new account is possible later", {
            until: decision.until.toISOString(),
          });
        }
        if (decision.reason === "suspended") {
          // The day it ends travels to the app as &until=, as the cooldown's does (ADR-024 §5).
          throw new AppError(
            403,
            "auth_suspended",
            "This person may not use Kuutti for now",
            decision.until ? { until: decision.until.toISOString() } : undefined,
          );
        }
        throw new AppError(403, "auth_banned", "This person may not use Kuutti");
      }
      case "create_identity": {
        const created = await repo.insertIdentity(deps.db, {
          hetuHmac: derived.hetuHmac,
          ...derived.reference,
        });
        if (!created) {
          if (attempt > 0) throw new Error("identity insert lost twice");
          continue;
        }
        const account = await repo.insertAccount(deps.db, {
          identityId: created.id,
          birthYear: derived.birthYear,
          birthMonth: derived.birthMonth,
        });
        return { accountId: account.id, outcome: "created" };
      }
      case "create_account": {
        await repo.updateBrokerReference(deps.db, decision.identityId, derived.reference);
        const account = await repo.insertAccount(deps.db, {
          identityId: decision.identityId,
          birthYear: derived.birthYear,
          birthMonth: derived.birthMonth,
        });
        return { accountId: account.id, outcome: "created" };
      }
      case "resume": {
        await repo.updateBrokerReference(deps.db, decision.account.identityId, derived.reference);
        // A break ends with the login that follows it (#170, ADR-022); a second
        // device's login that got there first leaves this one a plain resume.
        if (decision.account.state === "paused" && (await resumeAccount(deps, decision.account))) {
          return { accountId: decision.account.id, outcome: "unpaused" };
        }
        return { accountId: decision.account.id, outcome: "resumed" };
      }
    }
  }
}

/** The broker's answer reduced to what the identity keeps; the hetu does not leave this function. */
async function deriveFromBroker(
  deps: LoginDeps,
  callbackUrl: URL,
  request: { state: string; nonce: string },
  now: Date,
) {
  // Whatever an adapter throws, the person's login did not complete at the
  // provider: a 502 with a stable code, never a bare 500 with the adapter's stack.
  let answer: BrokerIdentity;
  try {
    answer = await deps.broker.completeLogin({
      callbackUrl,
      state: request.state,
      nonce: request.nonce,
    });
  } catch (error) {
    if (error instanceof BrokerError) throw error;
    throw new BrokerError(error instanceof Error ? error.message : "broker failed");
  }
  let derived: ReturnType<typeof deriveIdentity>;
  try {
    derived = deriveIdentity(answer.hetu, deps.hmacKey, now);
  } catch (error) {
    if (error instanceof InvalidHetuError) throw new BrokerError(error.message);
    throw error;
  }
  return {
    hetuHmac: derived.hetuHmac,
    birthYear: derived.birthYear,
    birthMonth: derived.birthMonth,
    adult: derived.adult,
    reference: {
      brokerSubject: answer.subject,
      brokerSessionIndex: answer.sessionIndex,
      brokerTokenId: answer.tokenId,
      authenticatedAt: answer.authenticatedAt,
      acr: answer.acr,
      amr: answer.amr,
    },
  };
}

/** /auth/exchange: the one-time code, once, within its minute, with its attempt's verifier (ADR-027). */
export async function exchangeCode(
  deps: Pick<LoginDeps, "db" | "now">,
  input: { code: string; verifier: string },
): Promise<{
  accountId: string;
  platform: AuthPlatform;
  outcome: AuthExchangeResponse["outcome"];
}> {
  const login = await repo.consumeAppCode(deps.db, {
    codeHash: hashOneTimeCode(input.code),
    // The challenge is the same SHA-256 hex as the code's hash (ADR-027).
    codeChallenge: hashOneTimeCode(input.verifier),
    at: deps.now(),
  });
  if (!login) throw new AppError(401, "auth_code_used", "This code is unknown, used or expired");
  return {
    accountId: login.accountId,
    platform: login.platform === "android" ? "android" : "ios",
    outcome:
      login.outcome === "resumed" || login.outcome === "unpaused" ? login.outcome : "created",
  };
}
