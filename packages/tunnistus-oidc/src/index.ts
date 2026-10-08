// The relying-party kit's surface. The hetu format is `./hetu` and the test
// double `./testing` (subpath exports), so a consumer that needs one does not
// load the others.

export {
  ACR_LOA2,
  ACR_LOATEST2,
  type CompleteLoginInput,
  createTunnistusClient,
  FTN_CLAIMS,
  type FtnIdentity,
  HETU_CLAIM,
  identityFromClaims,
  registeredCallbackUrl,
  type StartLoginInput,
  TELIA_PREPRODUCTION_ISSUER,
  TELIA_PRODUCTION_ISSUER,
  type TunnistusClient,
  type TunnistusClientOptions,
  type TunnistusDialect,
  TunnistusError,
} from "./client.ts";
export {
  DiscoveryError,
  discoverProvider,
  isTeliaIssuer,
  ProviderMetadata,
} from "./discovery.ts";
export { type KeyUse, keyIdOf, publicJwk } from "./keys.ts";
