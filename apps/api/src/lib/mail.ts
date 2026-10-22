import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";

/** One plain-text message to one address (#385, ADR-043). */
export type MailMessage = { to: string; subject: string; text: string };

/** Where Kuutti's mail goes out: SES on AWS, the log on a developer's machine. */
export type Mailer = { send: (message: MailMessage) => Promise<void> };

/**
 * A send that failed, by the SDK's error name and HTTP status alone: SES
 * names the address in its messages (an unverified recipient in the
 * sandbox), and this error reaches a log line.
 */
export class MailFailed extends Error {
  constructor(
    readonly reason: string,
    readonly status: number | undefined,
  ) {
    super(`mail not sent: ${reason}`);
    this.name = "MailFailed";
  }
}

/** SES through the instance role (ADR-043 §5), from the configured sender. */
export function sesMailer(client: Pick<SESv2Client, "send">, from: string): Mailer {
  return {
    send: async ({ to, subject, text }) => {
      try {
        await client.send(
          new SendEmailCommand({
            FromEmailAddress: from,
            Destination: { ToAddresses: [to] },
            Content: {
              Simple: {
                Subject: { Data: subject, Charset: "UTF-8" },
                Body: { Text: { Data: text, Charset: "UTF-8" } },
              },
            },
          }),
        );
      } catch (error) {
        const reason = error instanceof Error ? error.name : "unknown";
        const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
          ?.httpStatusCode;
        throw new MailFailed(reason, status);
      }
    },
  };
}

/**
 * A developer's machine and the tests (ADR-043 §4): the message is written to
 * the log instead of sent, so its code can be typed in the app. Never the
 * address. The configuration refuses it anywhere else, since a deployed log
 * is no place for a code; `preview` is a key the logger does not redact.
 */
export function logMailer(logger: Logger): Mailer {
  return {
    send: async ({ subject, text }) => {
      logger.info({ preview: `${subject}\n\n${text}` }, "mail not sent: written here instead");
    },
  };
}

/** The mailer the configuration names; none when MAIL is off, and the routes that send answer 503. */
export function mailerFor(config: Config, logger: Logger): Mailer | undefined {
  if (config.MAIL === "ses") {
    // The send runs inside the transaction that holds the account's row and a
    // pool connection (identity/email.ts), so a hanging SES is cut short:
    // at most two tries of five seconds, then 503 and the rollback.
    const client = new SESv2Client({
      region: config.S3_REGION,
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 2_000, requestTimeout: 5_000 },
    });
    return sesMailer(client, config.MAIL_FROM);
  }
  if (config.MAIL === "log") return logMailer(logger);
  return undefined;
}
