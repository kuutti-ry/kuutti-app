# @kuutti/tunnistus-oidc

A relying-party kit for [Telia Tunnistus](https://github.com/telia-oss/tunnistus), the Finnish Trust Network identification broker, for Node 22+. It does what Telia's integration guide (v2.36) asks of a client and what no sample does: it ships a faithful in-process double of the broker, so the whole dialect is tested without a contract, a network or a port.

MIT-licensed (see `LICENSE`), unlike the rest of this repository, so that the next Finnish relying party can take it. It is a workspace package of the Kuutti monorepo today; publishing to npm is a release decision of its own (a build step, provenance, a changelog), see ADR-017.

## What it does

- **`createTunnistusClient(options)`**: the OpenID Connect client in Telia's dialect: a signed request object (RS256, `acr_values` mandatory under Traficom 213/2023 S), `private_key_jwt` at the token endpoint with `aud` = the token endpoint, and an ID token that arrives as a JWE encrypted to your `enc` key and signed by Telia, verified against the issuer's JWKS, which is read by URL and never pinned, so a rotated key is picked up without a restart. A `plain` dialect runs the same client against an ordinary OpenID provider over http, for a local mock.
- **`discoverProvider(issuer)`**: the provider metadata, validated, with the issuer checked character for character.
- **`keyIdOf(pem)`** and **`publicJwk(pem, use)`**: the RFC 7638 thumbprint Telia names your `enc` key by in every JWE header, and the JWK you register.
- **`@kuutti/tunnistus-oidc/hetu`**: the Finnish personal identity code (henkilötunnus): parse, every century sign of the 2023 reform, check character, the reason a code is refused (`format`, `checksum`, `date`, `individual`, safe to log), age from year and month, and a generator for seeds and tests. It never derives legal sex.
- **`@kuutti/tunnistus-oidc/testing`**: `fakeTelia()`, the broker as the guide describes it, answering through a `fetch` function under the real pre-production issuer, checking every requirement and able to misbehave on purpose (a plain ID token, a stranger's key, another nonce or audience, no identity code, no `auth_time`, a rotated signing key, a person who cancels). Needs `hono` (an optional peer dependency).

## Use

```ts
import { ACR_LOATEST2, createTunnistusClient, TunnistusError } from "@kuutti/tunnistus-oidc";

const telia = await createTunnistusClient({
  issuer: "https://tunnistus-pp.telia.fi/uas",
  clientId: "…", // assigned by Telia at registration
  redirectUri: "https://api.example.fi/auth/callback", // registered, exact, https
  acrValues: ACR_LOATEST2, // ACR_LOA2 in production
  signingKeyPem, // PKCS#8, RSA 2048+, the key whose public JWK you registered with "use": "sig"
  encryptionKeyPem, // the "use": "enc" one; the ID token is encrypted to it
});

// 1. Send the browser to the bank chooser; keep state and nonce server-side.
const url = await telia.startLogin({ state, nonce, uiLocales: "fi", prompt: "login" });

// 2. At your redirect URI, exchange the code. Everything is verified before this returns:
//    state, nonce, the JWE, the JWS signature against the JWKS, iss, aud, exp, acr, auth_time.
try {
  const person = await telia.completeLogin({ callbackUrl: new URL(request.url), state, nonce });
  person.personalIdentityCode; // in memory only; derive what you keep and drop it
  person.acr; // the level asked for
  person.amr; // the method, as a URI Telia names it
  person.authenticatedAt; // auth_time
} catch (error) {
  if (error instanceof TunnistusError) error.reason; // "unexpected acr", "no identity code", …
}
```

The person who backs out at the bank comes back with `error=access_denied` and no code; read the query before calling `completeLogin`.

Keys: generate two RSA pairs, keep the private halves where your service reads secrets, and send Telia the two public JWKs (`publicJwk(pem, "sig")`, `publicJwk(pem, "enc")`) with your redirect URIs and `ftn_spname`. Telia's pre-production bed is `tunnistus-pp.telia.fi`, production `tunnistus.telia.fi`.

## Testing with the double

```ts
import { fakeTelia } from "@kuutti/tunnistus-oidc/testing";

const telia = await fakeTelia();
const client = await createTunnistusClient({ ...telia, acrValues: ACR_LOATEST2, fetch: telia.fetch });
const url = await client.startLogin({ state, nonce });
const back = await telia.authorize(url); // the browser's trip, in process
const person = await client.completeLogin({ callbackUrl: back, state, nonce });
telia.misbehave.plainIdToken = true; // and so on; see `Misbehaviour`
```

`src/client.telia.test.ts` is the conformance suite: each requirement of the guide is either produced by the client and checked by the double, or produced wrongly by the double and refused by the client.

## Not in here

Everything a product decides: what of the person is kept, session handling, how often the bank is asked (Kuutti sends `prompt=login` every time and refuses an `auth_time` older than its own request; that is the caller's policy), logging. The client returns what Telia sent and throws `TunnistusError` with a reason and nothing else (no `cause`: the underlying library attaches the decoded claims to its errors, and the kit leaves them behind); it logs nothing.
