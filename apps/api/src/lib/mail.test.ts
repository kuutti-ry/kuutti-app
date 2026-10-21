import { MessageRejected, SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureLogger, type LogLine, testConfig } from "../test/harness.ts";
import { serializeError } from "./logger.ts";
import { logMailer, MailFailed, type MailMessage, mailerFor, sesMailer } from "./mail.ts";

// The mailers of #385 (ADR-043 §4-5): SES through a client that answers
// without the network, the development log, and the choice between them.
// What a confirmation does with them is identity/email-confirmation.test.ts's.

const ADDRESS = "aino.mail@example.fi";
const FROM = "Kuutti <noreply@kuutti.app>";
const MESSAGE: MailMessage = {
  to: ADDRESS,
  subject: "Your code for Kuutti",
  text: "Your code is 042042. It works for 30 minutes.\n\nKuutti ry",
};
/** Anything shaped like an address, however a line would carry it. */
const ADDRESS_SHAPED = /[\w.+-]+@[\w-]+\.[\w.]+/;

/** An SES client that records each command and answers with what it is given. */
function answering(answer: () => Promise<unknown>) {
  const sent: unknown[] = [];
  const client = {
    async send(command: unknown) {
      sent.push(command);
      return answer();
    },
  } as unknown as SESv2Client;
  return { client, sent };
}

/** What a failed send threw, once the mailer has turned it into its own error. */
async function failureOf(thrown: unknown): Promise<MailFailed> {
  const { client } = answering(() => Promise.reject(thrown));
  const failure = await sesMailer(client, FROM)
    .send(MESSAGE)
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(failure).toBeInstanceOf(MailFailed);
  return failure as MailFailed;
}

describe("the SES mailer (ADR-043 §5)", () => {
  it("sends one plain-text message in UTF-8 from the configured sender to the one address", async () => {
    const { client, sent } = answering(async () => ({ MessageId: "m-1" }));
    await expect(sesMailer(client, FROM).send(MESSAGE)).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(SendEmailCommand);
    expect((sent[0] as SendEmailCommand).input).toEqual({
      FromEmailAddress: FROM,
      Destination: { ToAddresses: [ADDRESS] },
      Content: {
        Simple: {
          Subject: { Data: MESSAGE.subject, Charset: "UTF-8" },
          Body: { Text: { Data: MESSAGE.text, Charset: "UTF-8" } },
        },
      },
    });
  });

  it("turns a refusal into the SDK's error name and HTTP status, and names no address", async () => {
    // How SES refuses an unverified recipient in the sandbox: the address is in the message.
    const refusal = new MessageRejected({
      message: `Email address is not verified. The following identities failed the check in region EU-CENTRAL-1: ${ADDRESS}`,
      $metadata: { httpStatusCode: 400, requestId: "r-1" },
    });
    const failure = await failureOf(refusal);
    expect(failure.name).toBe("MailFailed");
    expect(failure.reason).toBe("MessageRejected");
    expect(failure.status).toBe(400);
    expect(failure.message).toBe("mail not sent: MessageRejected");
    // Nothing of the SDK's error rides along: no cause, no copy of its message.
    expect(failure.cause).toBeUndefined();
    for (const carried of [
      failure.message,
      String(failure),
      failure.stack ?? "",
      JSON.stringify(failure),
      JSON.stringify(serializeError(failure)),
    ]) {
      expect(carried).not.toMatch(ADDRESS_SHAPED);
    }
  });

  it("names a refusal without an HTTP status by its name alone", async () => {
    // A network failure before any answer: the SDK's error has no $metadata.
    const failure = await failureOf(
      Object.assign(new Error("socket hang up"), { name: "TimeoutError" }),
    );
    expect([failure.reason, failure.status]).toEqual(["TimeoutError", undefined]);
  });

  it.each([
    ["a string", `refused for ${ADDRESS}`],
    ["null", null],
    ["a plain object", { $metadata: { httpStatusCode: 500 } }],
  ])("calls %s thrown in place of an error unknown", async (_kind, thrown) => {
    const failure = await failureOf(thrown);
    expect(failure.reason).toBe("unknown");
    expect(failure.message).not.toMatch(ADDRESS_SHAPED);
    // Not an Error, but SDK-shaped: its status is still read.
    expect(failure.status).toBe(thrown !== null && typeof thrown === "object" ? 500 : undefined);
  });
});

describe("the log mailer (ADR-043 §4)", () => {
  it("writes the subject and the text under preview, and never the address", async () => {
    const { logger, lines } = await captureLogger();
    await expect(logMailer(logger).send(MESSAGE)).resolves.toBeUndefined();
    const written: LogLine[] = lines();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      msg: "mail not sent: written here instead",
      preview: `${MESSAGE.subject}\n\n${MESSAGE.text}`,
    });
    // The code is there to be typed; the address is in no key and no value.
    expect(JSON.stringify(written)).toContain("042042");
    expect(JSON.stringify(written)).not.toMatch(ADDRESS_SHAPED);
  });
});

describe("the mailer the configuration names", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends through SES in the configured region from the configured sender, and logs nothing", async () => {
    // The client's own send, answered here: no credentials, no network.
    const regions: string[] = [];
    const attempts: number[] = [];
    const sent: SendEmailCommand[] = [];
    vi.spyOn(SESv2Client.prototype, "send").mockImplementation(async function (
      this: SESv2Client,
      command: unknown,
    ) {
      regions.push(await this.config.region());
      attempts.push(await this.config.maxAttempts());
      sent.push(command as SendEmailCommand);
      return {};
    } as never);
    const { logger, lines } = await captureLogger();
    const config = testConfig({
      MAIL: "ses",
      S3_REGION: "eu-north-1",
      MAIL_FROM: "Kuutti Staging <noreply@kuutti.app>",
    });
    const mailer = mailerFor(config, logger);
    expect(mailer).toBeDefined();
    await mailer?.send(MESSAGE);
    expect(regions).toEqual(["eu-north-1"]);
    // Two tries at most: the send holds the account's row while it waits.
    expect(attempts).toEqual([2]);
    expect(sent.map((c) => [c.input.FromEmailAddress, c.input.Destination?.ToAddresses])).toEqual([
      ["Kuutti Staging <noreply@kuutti.app>", [ADDRESS]],
    ]);
    expect(lines()).toEqual([]);
  });

  it("writes to the log when MAIL is log", async () => {
    const { logger, lines } = await captureLogger();
    await mailerFor(testConfig({ MAIL: "log" }), logger)?.send(MESSAGE);
    expect(lines().map((l) => l.preview)).toEqual([`${MESSAGE.subject}\n\n${MESSAGE.text}`]);
  });

  it("has none when MAIL is off", async () => {
    const { logger } = await captureLogger();
    expect(mailerFor(testConfig({ MAIL: "off" }), logger)).toBeUndefined();
  });
});
