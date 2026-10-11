import { AppError } from "../lib/errors.ts";

/**
 * What a bank login yields, and nothing more (#33, TD-1). The hetu is here for
 * the length of the callback: the caller derives hetu_hmac and the age from it
 * and drops the object. Names, dates of birth and every other claim the broker
 * sends stay inside the adapter and never reach this type (rules 1 and 3).
 */
export type BrokerIdentity = {
  hetu: string;
  /** The broker's own subject; opaque, stability per docs/vendors/telia.md. */
  subject: string;
  sessionIndex: string | null;
  tokenId: string | null;
  authenticatedAt: Date;
  acr: string;
  amr: string[];
};

export type StartLoginInput = { state: string; nonce: string; locale: string | null };
export type CompleteLoginInput = { callbackUrl: URL; state: string; nonce: string };

/**
 * The seam between the login and whoever brokers it. Telia's dialect (signed
 * request object, private_key_jwt, encrypted ID token) and the mock's plain
 * OIDC are two configurations of one adapter today; another broker, or the
 * Suomi.fi wallet later, is another adapter, and nothing else in the API
 * knows the difference.
 */
export interface IdentityBroker {
  readonly issuer: string;
  startLogin(input: StartLoginInput): Promise<URL>;
  completeLogin(input: CompleteLoginInput): Promise<BrokerIdentity>;
}

/** The broker answered, but not with a login: an error redirect, a bad token, a missing claim. */
export class BrokerError extends AppError {
  constructor(detail: string) {
    super(502, "auth_provider_error", "The identification service did not complete the login", {
      detail,
    });
    this.name = "BrokerError";
  }
}
