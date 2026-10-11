import {
  createTunnistusClient,
  isTeliaIssuer,
  keyIdOf,
  type TunnistusClient,
  type TunnistusClientOptions,
  TunnistusError,
} from "@kuutti/tunnistus-oidc";
import type { Config } from "../lib/config.ts";
import { BrokerError, type BrokerIdentity, type IdentityBroker } from "./broker.ts";

/**
 * The Telia client of `@kuutti/tunnistus-oidc` behind the login's seam (#33,
 * ADR-017). What the adapter adds is Kuutti's: the bank every time
 * (`prompt=login`, ADR-016); the answer reduced to what the callback may
 * hold, the code for deriving and the event's references, never a name or a
 * date of birth (rules 1 and 3); and the kit's refusals as the API's error.
 * Both dialects, Telia's and the mock IdP's plain OIDC, are the kit's; the
 * issuer decides at boot, never per request.
 */
export type OidcBrokerOptions = {
  issuer: string;
  clientId: string;
  redirectUri: string;
  acrValues: string | null;
  /** PEM (PKCS#8). Both required for a Telia issuer, both ignored for the mock. */
  signingKeyPem: string | null;
  encryptionKeyPem: string | null;
  /** Tests hand in the fake Telia's fetch (`@kuutti/tunnistus-oidc/testing`); production leaves it unset. */
  fetch?: TunnistusClientOptions["fetch"];
};

/** The kids the maintainer compares with what Telia registered; public values, logged at boot. */
export function teliaKeyIds(config: Config): { signing: string | null; encryption: string | null } {
  return {
    signing: config.TELIA_SIGNING_KEY ? keyIdOf(config.TELIA_SIGNING_KEY) : null,
    encryption: config.TELIA_ENCRYPTION_KEY ? keyIdOf(config.TELIA_ENCRYPTION_KEY) : null,
  };
}

export function brokerOptionsFromConfig(config: Config): OidcBrokerOptions | null {
  if (!config.OIDC_ISSUER || !config.OIDC_CLIENT_ID || !config.OIDC_REDIRECT_URI) return null;
  return {
    issuer: config.OIDC_ISSUER,
    clientId: config.OIDC_CLIENT_ID,
    redirectUri: config.OIDC_REDIRECT_URI,
    acrValues: config.OIDC_ACR_VALUES ?? null,
    signingKeyPem: config.TELIA_SIGNING_KEY ?? null,
    encryptionKeyPem: config.TELIA_ENCRYPTION_KEY ?? null,
  };
}

export class OidcBroker implements IdentityBroker {
  private constructor(
    readonly issuer: string,
    private readonly client: TunnistusClient,
  ) {}

  /** Discovery once, at boot; a Telia issuer without our keys is a configuration error, named by its parameters. */
  static async create(options: OidcBrokerOptions): Promise<OidcBroker> {
    if (isTeliaIssuer(options.issuer) && (!options.signingKeyPem || !options.encryptionKeyPem)) {
      throw new Error("a Telia issuer needs TELIA_SIGNING_KEY and TELIA_ENCRYPTION_KEY");
    }
    return new OidcBroker(options.issuer, await createTunnistusClient(options));
  }

  startLogin(input: { state: string; nonce: string; locale: string | null }): Promise<URL> {
    // ADR-016: the bank, every time. The broker keeps a web session in the
    // system browser, and on a shared phone the second person must never be
    // let in under the first one's identity (guide 2.4.3: prompt=login).
    return this.client.startLogin({
      state: input.state,
      nonce: input.nonce,
      uiLocales: input.locale,
      prompt: "login",
    });
  }

  async completeLogin(input: {
    callbackUrl: URL;
    state: string;
    nonce: string;
  }): Promise<BrokerIdentity> {
    try {
      const person = await this.client.completeLogin(input);
      // The names and the date of birth stay here and go with this frame (rule 3).
      return {
        hetu: person.personalIdentityCode,
        subject: person.subject,
        sessionIndex: person.sessionIndex,
        tokenId: person.tokenId,
        authenticatedAt: person.authenticatedAt,
        acr: person.acr,
        amr: person.amr,
      };
    } catch (error) {
      if (error instanceof TunnistusError) throw new BrokerError(error.reason);
      throw error;
    }
  }
}
