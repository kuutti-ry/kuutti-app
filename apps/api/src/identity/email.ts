import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { type Queryable, transaction } from "@kuutti/db";
import type { TFunction } from "@kuutti/i18n";
import { type AccountEmailResponse, EMAIL_CODE_LENGTH } from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import { type Mailer, MailFailed } from "../lib/mail.ts";
import { matchingConfigNumbers } from "../lib/matching-config.ts";
import { dayWindow, secondsUntil } from "../media/index.ts";
import * as repo from "./repo.ts";

/**
 * The optional e-mail confirmed by a code (#385, ADR-043,
 * features/identity/email-confirmation.feature): a new or changed address is
 * unconfirmed; a code of six digits is sent to it on request, at most
 * matching_config email_codes_per_day a Finnish day; typed right within
 * email_code_minutes and email_code_attempts, it confirms the address. Only
 * the code's hash is stored. The address and the code reach no log line and
 * no event (rules/api.md).
 */

export const EMAIL_CODE_MINUTES_KEY = "email_code_minutes";
export const EMAIL_CODE_ATTEMPTS_KEY = "email_code_attempts";
export const EMAIL_CODES_PER_DAY_KEY = "email_codes_per_day";

/** Six digits from a number below a million, zeros in front. */
export const codeOf = (n: number): string => String(n).padStart(EMAIL_CODE_LENGTH, "0");

/** A code from the operating system's generator; tests read it from the message, as a person would. */
const randomCode = (): string => codeOf(randomInt(0, 10 ** EMAIL_CODE_LENGTH));

/**
 * What is stored of a code: its SHA-256 with the account's id in front, so two
 * accounts' equal codes are told apart. Never an HMAC with the hetu's key,
 * which is for the hetu and nothing else (security checklist).
 */
export const hashCode = (accountId: string, code: string): string =>
  createHash("sha256").update(`${accountId}:${code}`).digest("hex");

const sameHash = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

export type EmailDeps = {
  db: Queryable;
  logger: Logger;
  now: () => Date;
  /** Absent where MAIL is off: a send answers 503 mail_unavailable. */
  mailer?: Mailer;
};

const noAccount = () => new AppError(404, "not_found", "No live account");
const noAddress = () => new AppError(409, "email_none", "No address is set");

function viewOf(state: repo.EmailState, at: Date): AccountEmailResponse {
  const { codeExpiresAt } = state;
  const confirmed = state.confirmedAt !== null;
  return {
    email: state.email,
    confirmed,
    // A confirmed address has no code waiting: the confirmation deletes it and
    // a send refuses one. The state may still name one when its read waited for
    // the confirmation's lock, since the lock re-reads the account's row but
    // not the joined code (repo.findEmailState). A code past its end waits for
    // nothing either, though its row stays until it is typed or replaced.
    codeExpiresAt:
      !confirmed && codeExpiresAt !== null && codeExpiresAt > at
        ? codeExpiresAt.toISOString()
        : null,
  };
}

/** The caller's own address, whether it is confirmed, and until when a code waits. */
export async function readEmail(deps: EmailDeps, accountId: string): Promise<AccountEmailResponse> {
  const state = await repo.findEmailState(deps.db, accountId);
  if (!state) throw noAccount();
  return viewOf(state, deps.now());
}

/** Set, change or clear the address; a different one is unconfirmed and its waiting code goes. */
export async function setAccountEmail(
  deps: EmailDeps,
  accountId: string,
  email: string | null,
): Promise<AccountEmailResponse> {
  const set = await repo.setEmail(deps.db, accountId, email);
  if (!set) throw noAccount();
  // The address stays out of the log (rules/api.md): this line says only what happened.
  deps.logger.info(
    { accountId, changed: set.changed },
    email === null ? "email cleared" : "email set",
  );
  return readEmail(deps, accountId);
}

/**
 * A new code to the caller's unconfirmed address. The send happens inside the
 * transaction that counts and stores it: a send that fails rolls both back,
 * so no code waits that never arrived and the day's count is not spent on it.
 */
export async function sendEmailCode(
  deps: EmailDeps,
  accountId: string,
  t: TFunction,
): Promise<AccountEmailResponse> {
  const { mailer } = deps;
  if (!mailer) throw new AppError(503, "mail_unavailable", "No mail is sent here");
  const at = deps.now();
  const day = dayWindow(at);
  const numbers = await matchingConfigNumbers(deps.db, [
    EMAIL_CODE_MINUTES_KEY,
    EMAIL_CODES_PER_DAY_KEY,
  ]);
  const minutes = numbers[EMAIL_CODE_MINUTES_KEY];
  const limit = numbers[EMAIL_CODES_PER_DAY_KEY];
  const code = randomCode();
  const expiresAt = new Date(at.getTime() + minutes * 60_000);
  let outcome:
    | { kind: "gone" }
    | { kind: "none" }
    | { kind: "confirmed" }
    | { kind: "budget"; used: number }
    | { kind: "sent"; state: repo.EmailState };
  try {
    outcome = await transaction(deps.db, async (tx) => {
      const state = await repo.findEmailState(tx, accountId, { lock: true });
      if (!state) return { kind: "gone" as const };
      if (state.email === null) return { kind: "none" as const };
      if (state.confirmedAt !== null) return { kind: "confirmed" as const };
      const recorded = await repo.recordEmailCode(tx, {
        accountId,
        codeHash: hashCode(accountId, code),
        at,
        expiresAt,
        since: day.start,
        limit,
      });
      if (!recorded.recorded) return { kind: "budget" as const, used: recorded.used };
      await mailer.send({
        to: state.email,
        subject: t("mail.emailCode.subject"),
        // Paragraphs are separate texts: a message in messages.yaml holds no line break.
        text: [
          t("mail.emailCode.code", { code, minutes }),
          t("mail.emailCode.ignore"),
          t("mail.signature"),
        ].join("\n\n"),
      });
      return { kind: "sent" as const, state: { ...state, codeExpiresAt: expiresAt } };
    });
  } catch (error) {
    if (!(error instanceof MailFailed)) throw error;
    // The SDK's name and status only: SES names the address in its messages.
    deps.logger.warn(
      { accountId, reason: error.reason, status: error.status },
      "email code not sent",
    );
    throw new AppError(503, "mail_unavailable", "The code could not be sent");
  }
  if (outcome.kind === "gone") throw noAccount();
  if (outcome.kind === "none") throw noAddress();
  if (outcome.kind === "confirmed") {
    throw new AppError(409, "email_confirmed", "The address is confirmed already");
  }
  if (outcome.kind === "budget") {
    const retryAfterSeconds = secondsUntil(day.end, at);
    deps.logger.warn(
      { accountId, used: outcome.used, limit, retryAfterSeconds },
      "email code refused",
    );
    throw new AppError(429, "email_code_budget_exceeded", "The day's codes are sent", {
      retryAfterSeconds,
    });
  }
  deps.logger.info({ accountId }, "email code sent");
  return viewOf(outcome.state, at);
}

/**
 * The code typed in the app. Right, within its minutes and attempts, it
 * confirms the address and goes; wrong, it counts an attempt, and the last
 * one spends it; expired, it goes. What the transaction changed stays even
 * when the answer is a refusal: the refusal is thrown after the commit.
 */
export async function confirmEmailCode(
  deps: EmailDeps,
  accountId: string,
  code: string,
): Promise<AccountEmailResponse> {
  const at = deps.now();
  const { [EMAIL_CODE_ATTEMPTS_KEY]: allowed } = await matchingConfigNumbers(deps.db, [
    EMAIL_CODE_ATTEMPTS_KEY,
  ]);
  const outcome = await transaction(deps.db, async (tx) => {
    const state = await repo.findEmailState(tx, accountId, { lock: true });
    if (!state) return { kind: "gone" as const };
    if (state.email === null) return { kind: "none" as const };
    // Typed again after it worked (a second tap, a second phone): the answer is the same.
    if (state.confirmedAt !== null) return { kind: "confirmed" as const, state };
    const waiting = await repo.findEmailCode(tx, accountId);
    if (!waiting) return { kind: "no_code" as const };
    if (waiting.expiresAt <= at) {
      await repo.deleteEmailCode(tx, accountId);
      return { kind: "expired" as const };
    }
    if (sameHash(waiting.codeHash, hashCode(accountId, code))) {
      await repo.confirmEmail(tx, accountId, at);
      await repo.deleteEmailCode(tx, accountId);
      return {
        kind: "confirmed" as const,
        state: { ...state, confirmedAt: at, codeExpiresAt: null },
      };
    }
    const attempts = waiting.attempts + 1;
    if (attempts >= allowed) {
      await repo.deleteEmailCode(tx, accountId);
      return { kind: "spent" as const };
    }
    await repo.setEmailCodeAttempts(tx, accountId, attempts);
    return { kind: "wrong" as const, attemptsLeft: allowed - attempts };
  });
  switch (outcome.kind) {
    case "gone":
      throw noAccount();
    case "none":
      throw noAddress();
    case "no_code":
      throw new AppError(409, "email_code_none", "No code waits for this address");
    case "expired":
      deps.logger.info({ accountId }, "email code expired");
      throw new AppError(409, "email_code_expired", "The code has expired");
    case "spent":
      deps.logger.warn({ accountId, attempts: allowed }, "email code spent");
      throw new AppError(409, "email_code_spent", "Too many wrong codes");
    case "wrong":
      deps.logger.info({ accountId, attemptsLeft: outcome.attemptsLeft }, "email code wrong");
      throw new AppError(400, "email_code_wrong", "The code is not right", {
        attemptsLeft: outcome.attemptsLeft,
      });
    case "confirmed":
      deps.logger.info({ accountId }, "email confirmed");
      return viewOf(outcome.state, at);
  }
}
