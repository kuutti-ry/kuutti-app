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
  // lists several. Anything that does not offer it cannot be the broker.
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
  return parsed.data;
}

/** Telia's pre-production and production hosts, where the Telia dialect is the only one. */
export function isTeliaIssuer(issuer: string): boolean {
  return /^https:\/\/tunnistus(-pp)?\.telia\.fi\//.test(issuer);
}
