import { z } from "zod";

/**
 * The part of an OpenID provider's metadata a relying party checks at boot:
 * read from `<issuer>/.well-known/openid-configuration` so that the broker's
 * endpoints and rotating keys are never configuration. What the broker
 * publishes is what the process uses. A mock publishes the same document, so
 * the check runs locally too.
 */
export const ProviderMetadata = z.object({
  issuer: z.url(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  // Telia authenticates clients with private_key_jwt only (guide 2.6); a mock
  // lists several. A document on Telia's host that does not offer it cannot
  // be the broker, and discoverProvider refuses it.
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  acr_values_supported: z.array(z.string()).optional(),
});
export type ProviderMetadata = z.infer<typeof ProviderMetadata>;

export class DiscoveryError extends Error {
  constructor(
    readonly issuer: string,
    detail: string,
  ) {
    super(`OpenID discovery for ${issuer} failed: ${detail}`);
    this.name = "DiscoveryError";
  }
}

type Fetch = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/**
 * Fetches and validates the provider's metadata. The `issuer` in the document
 * must equal the configured one, character for character (OpenID Connect
 * Discovery 4.3): a document served from somewhere else is not the broker.
 * On Telia's host the document must offer private_key_jwt (guide 2.6).
 */
export async function discoverProvider(
  issuer: string,
  fetchImpl: Fetch = fetch,
  timeoutMs = 5000,
): Promise<ProviderMetadata> {
  const normalised = issuer.replace(/\/$/, "");
  const url = `${normalised}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new DiscoveryError(issuer, error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) throw new DiscoveryError(issuer, `HTTP ${response.status} from ${url}`);
  const parsed = ProviderMetadata.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new DiscoveryError(issuer, `metadata is not a provider document (${url})`);
  }
  if (parsed.data.issuer !== normalised) {
    throw new DiscoveryError(issuer, `document names issuer ${parsed.data.issuer}`);
  }
  if (
    isTeliaIssuer(issuer) &&
    !parsed.data.token_endpoint_auth_methods_supported?.includes("private_key_jwt")
  ) {
    throw new DiscoveryError(issuer, "no private_key_jwt at the token endpoint");
  }
  return parsed.data;
}

const TELIA_HOSTS = new Set(["tunnistus.telia.fi", "tunnistus-pp.telia.fi"]);

/**
 * The issuer as URL when it names one of Telia's two hosts, whatever its
 * scheme or port. Read through URL, as the client reads the issuer it
 * connects to: the host in any case, the trailing dot of a fully qualified
 * name (#235).
 */
function teliaHostUrl(issuer: string): URL | null {
  const url = URL.parse(issuer);
  return url && TELIA_HOSTS.has(url.hostname.replace(/\.$/, "")) ? url : null;
}

/** On Telia's host, whatever the scheme or port: where nothing but the Telia dialect may speak. */
export function isOnTeliaHost(issuer: string): boolean {
  return teliaHostUrl(issuer) !== null;
}

/**
 * Telia's pre-production and production issuers, where the Telia dialect is
 * the only one: its host over https on the default port, written or not.
 * Telia's documents name https issuers, so an http one is never the broker.
 */
export function isTeliaIssuer(issuer: string): boolean {
  const url = teliaHostUrl(issuer);
  return url?.protocol === "https:" && url.port === "";
}
