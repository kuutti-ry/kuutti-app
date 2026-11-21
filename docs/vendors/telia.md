# Telia Tunnistus (Finnish Trust Network broker)

What Telia's identification broker is to us, what we owe them and what they owe us. Source: *Telia Tunnistus – Integration guide to the identification broker service* v2.36 (2026-02-06) and the *Key Rotation* note (2026-01-07), both published at https://github.com/telia-oss/tunnistus; this file and the tests follow them. The correspondence with Telia, the offer and the agreement with its prices are in the association's mailbox and never here (the maintainer, 17/11/2026). No credentials in this file (#32).

## The relationship

Telia Tunnistus is a contracted service, not a self-service API. The association's agreement with Telia Finland Oyj (business ID 1475607-9) covers production; its Appendix 4 names the **technical contact**, the one person allowed to exchange keys with Telia, who is the maintainer. The pre-production environment (`tunnistus-pp.telia.fi`) is free and needs no agreement. A client that passes there is moved to production (`tunnistus.telia.fi`) on request, and billing starts with production.

- Contacts: provisioning, metadata and technical questions, **id-maintenance@teliacompany.com**; faults 24/7, 0200 20 300.
- The pre-production client exists since 2026-10-08: `client_id` `b9b08a7a-ebb4-4a8c-a3e7-52824d3231e5`, redirect URI `https://api.staging.kuutti.app/auth/callback`; the id is the default of `telia_client_id` in `infra/envs/staging/variables.tf`.

Sales entry, for the record: https://www.telia.fi/yrityksille/palvelut/tietoturva/tunnistautuminen (*Telia Tunnistus*, "ota yhteyttä").

## The bill (#471)

Production is billed from the move to production; the pre-production bed is free. The package and its prices are in the agreement, in the association's mailbox. No production connection has been requested yet (#25). In the trust network the law caps what a bank may charge a broker at 3 cents for each identification it passes on (Act 617/2009 §12 c).

What Kuutti counts: one API line `identified at the bank` for each callback whose broker answer is verified and fresh, before the rule decides anything, so a new account, a resume, the end of a break, a staff sign-in and a refusal each count once; a cancel at the bank, a failed token call and an answer older than its attempt (ADR-016 §2) do not. The observability module sums the lines as `BankIdentifications` in `Kuutti/<env>` and mails when a day reaches `bank_identifications_per_day` (`docs/runbooks/alerts.md`). The month's count, to choose the package from, is the metric's sum over the month (the alarm's row has the command).

Months counted: none, since billing starts at the move to production and none has been requested.

## What Telia needs from us (guide section 2.1)

| item | ours |
|---|---|
| public keys, RSA 2048 or longer, **two separate JWKs**: `"use": "sig"` (signs our request objects and client assertions) and `"use": "enc"` (Telia encrypts the ID token to it) | generated per `infra/README.md` Secrets; the private halves live in SSM `/kuutti/<env>/telia-signing-key` and `/kuutti/<env>/telia-encryption-key`; the public JWKs go to Telia by e-mail (an OpenID Federation entity statement is the alternative; not used yet) |
| redirect URIs, HTTPS, **no wildcards** | staging `https://api.staging.kuutti.app/auth/callback`; production `https://api.kuutti.app/auth/callback` (#25) |
| display name `ftn_spname`, at most 40 characters, shown to the user during login | `Kuutti` |
| technical contact (Appendix 4) | the maintainer, with the project mailbox in copy |

Production keys are confirmed through Telia's e-signature service: the technical contact signs the offered keys (or the entity statement) with strong identification.

### Registering a client

A client is registered by one mail from the project mailbox to id-maintenance@teliacompany.com (guide 2.1), carrying:

1. Protocol: **OIDC**, with `private_key_jwt`, signed request objects and the encrypted ID token (guide 2.4–2.6). Pre-production first.
2. `ftn_spname`, shown to the person as "Tunnistuspyyntö 12345, lähettäjä Kuutti".
3. The client metadata, `kuutti-<env>-telia-client.json`, written by `infra/scripts/telia-keys.sh <env> <offline-medium>` in the shape of the Python sample's `client.json` (`KUUTTI_TELIA_CONTACT` supplies the contact address, so none is in the repository): the redirect URI (Telia's whitelist; each environment's client has its own, and its own keys), `client_name#fi/sv/en` and `ftn_spname`, the organisation and contact, the algorithms (`private_key_jwt`, RS256 request objects and ID tokens, `RSA-OAEP` with `A128CBC-HS256`), and the two public keys as JWKs: `use: sig` (signs request objects and client assertions) and `use: enc` (the ID token is encrypted to it). The mail says which key is which.

Registered kids, staging, generated 2026-10-07 (public values; the API logs the same two at boot): `sig` `h3459Y74bDyIP_F8RPGkACWjOouvJzgdw0vGtZ9bi7I`, `enc` `faflNFy64dbC2qZ25QUUPN1bfBePnOpcJAaUfV3l-QQ`. The three staging secrets exist in SSM since the same day (`telia-signing-key`, `telia-encryption-key`, `hetu-hmac-key`).

Telia answers with the `client_id`. It is public (every authorization URL carries it): set it as the default of `telia_client_id` in `infra/envs/staging/variables.tf` and merge; CI's apply then writes `oidc-issuer`, `oidc-client-id`, `oidc-redirect-uri` and `oidc-acr-values` under `/kuutti/staging/`. The two private keys must be in SSM before that (`telia-keys.sh … --put`): the API refuses to boot against a Telia issuer without them. Redeploy the API in Dokploy and read the boot line "bank identification": the two kids it logs must equal the kids of the JWKs Telia registered.

The first login on the test bed (2026-10-08) showed what was left to watch: `acr` came back as `loatest2` (the adapter accepts the level asked for, so a login that completes proves it), `prompt=login` sent each attempt through the bank with a fresh `auth_time` (ADR-016's check passed), the JWE header's `kid` was ours, and the outer query of `client_id` and `request` was accepted.

### The second name, `kumpa.fi` (#703, ADR-072)

The app is called Kumpa since 2026-11-16, and its hosts get names under `kumpa.fi` beside the `kuutti.app` ones (ADR-072). Telia matches the redirect URI exactly, so the bank's callback moves only once Telia has registered `https://api.staging.kumpa.fi/auth/callback` beside the present one; production's client carries `https://api.kumpa.fi/auth/callback` beside `https://api.kuutti.app/auth/callback` when it is requested. Until then, `oidc-redirect-uri`, `telia-keys.sh`'s metadata and the table above keep `kuutti.app`'s callback, and `ftn_spname` stays Kuutti (#700). Asking Telia is the maintainer's, and the correspondence stays off GitHub.

## What Telia gives us

- `client_id` (generated by Telia at registration) and the endpoints:
  pre-production issuer `https://tunnistus-pp.telia.fi/uas`, discovery `/uas/.well-known/openid-configuration`, authorization `/uas/oauth2/authorization`, token `/uas/oauth2/token`, JWKS `/uas/oauth2/metadata.jwks`, entity statement `/.well-known/openid-federation`; production the same under `https://tunnistus.telia.fi`.
- Checked live on 2026-10-07: both hosts' discovery documents name exactly these endpoints, offer `private_key_jwt`, RS256 for request objects and ID tokens, and encrypt ID tokens with `RSA-OAEP` and `A128GCM` or `A128CBC-HS256` (the adapter accepts both since then); neither publishes `acr_values_supported` or `ui_locales_supported`. The pre-production JWKS carries one `sig` and one `enc` key.
- Telia's signing keys rotate on Telia's schedule; the next keys are published in the metadata endpoints in advance (Key Rotation note, guide 2.7.1).
- Production disruptions are announced at `https://tunnistus.telia.fi/uas/resource/maintenance.txt`, one line in three languages separated by `|` (guide 1.3); nothing reads it yet. The API reads the JWKS by URL and pins nothing: `openid-client` keeps the set for five minutes and fetches it again when a token names a `kid` it does not hold (once the cached set is a minute old), so a key published in advance is used without a restart. The entity statements' SHA-256 fingerprints in the guide (2.2.1's table: production's effective 12.11.2025, pre-production's 29.10.2025; the worked example under the table prints another value for the same URL, so the table is the one to read) allow out-of-band checks; nothing pins them.

## The flow as Telia specifies it (section 2.4–2.6)

- Authorization request as a **signed request object** (RFC 9101, RS256 with our `sig` key): `iss` = client_id, `aud` = the issuer, `response_type=code`, `scope=openid`, `redirect_uri`, `state`, `nonce`, `jti`, `exp` (about 10 minutes), `ui_locales` (`fi`, `sv`, `en`), and **`acr_values`**, mandatory under the Traficom recommendation 213/2023 S: `http://ftn.ficora.fi/2017/loa2` in production, `http://ftn.ficora.fi/2017/loatest2` in pre-production (`OIDC_ACR_VALUES`).
- Token request with **`private_key_jwt`** (RFC 7523): `iss` = `sub` = client_id, `aud` = the token endpoint, `jti` single-use, `exp` within 60 minutes.
- The **ID token is a JWE** (RSA-OAEP, A128CBC-HS256) encrypted to our `enc` key and, inside, a JWT signed by Telia (RS256): decrypt, then verify `iss`, `aud`, `exp`, `nonce`, `acr`.
- A person who backs out at the bank comes back with `error=access_denied` and no code (guide 2.5.2); the API sends them into the app as `auth_cancelled`, not as a failure.
- Claims for a Finnish user through an FTN method: `sub` (opaque), `auth_time`, `acr`, `amr` (the bank, as a URI such as `https://tunnistus-pp.telia.fi/uas/saml2/names/ac/oidc.aktia.1`), `urn:oid:1.2.246.21` = **hetu**, `urn:oid:1.3.6.1.5.5.7.9.1` = date of birth, `urn:oid:2.5.4.4` surname, `urn:oid:1.2.246.575.1.14` given names, `urn:oid:2.16.840.1.113730.3.1.241` display name, `bank-tupasid`, `session_index`. The API keeps `sub`, `session_index`, the ID token's `jti`, `auth_time`, `acr`, `amr` (of the latest login, rewritten at each one) and the identifiers it derives (`hetu_hmac`, `birth_year`, `birth_month`); the rest is read and dropped (rules 1 and 3).

The mock IdP in `services/mock-idp` issues the same claim names and `acr`/`amr` shapes, so local development exercises the real parser. The Telia dialect itself (request object, `private_key_jwt`, the JWE) is exercised against the kit's double (`@kuutti-ry/tunnistus-oidc/testing`; `src/testing/fake-telia.ts` in kuutti-ry/tunnistus-oidc), an in-process provider written to the guide under the real pre-production issuer; see Conformance below.

## Conformance: guide clause → code → test

Since ADR-017 the client, discovery, the key helpers, the hetu format and the double are the kit's, `@kuutti-ry/tunnistus-oidc` (MIT), in its own repository kuutti-ry/tunnistus-oidc since 2026-10-22 (ADR-017 §6), which this repository takes from npm; the identity slice's `oidc-broker.ts` is the adapter that keeps Kuutti's part (`prompt=login`, what of the person is held, the API's error). The table's tests are the package's unless they name a route.

What the guide requires, where the API does it, and which test proves it. Levels, as agreed: pure functions with property or example tests; the adapter against a provider written to the guide (in process); the routes end to end on real Postgres with a broker double; the plain dialect against the real mock IdP in the compose job (`services/mock-idp/verify.ts` logs in once through the kit's client there, on every pull request, #426), through the e2e flows' logins (ADR-020) and, by hand, the kit's own `client.mock-idp.test.ts` against `pnpm env:up`; the whole thing by hand against the mock. On 2026-10-08 the whole of it ran against Telia's pre-production bed: the first complete login (Aktia's test person) went through the signed request object, the chooser, the encrypted ID token, the freshness check of ADR-016 and the identity derivation, and ended with a session on the phone (#32, #33).

| guide | requirement | code | test |
|---|---|---|---|
| 2.1.1, 2.3 | two RSA keys, `sig` and `enc`, 2048+ | `infra/README.md` Secrets; `createTunnistusClient` refuses a Telia issuer without both; `keyIdOf` and `publicJwk`, and through them the client at creation, refuse a key under 2048 bits, naming its size | `client.telia.test.ts` "does not start against a Telia issuer without both keys…"; `client.options.test.ts` "does not start with an RSA … key under 2048 bits…"; `keys.test.ts` "refuses an RSA key under 2048 bits…"; the adapter names the SSM parameters, `apps/api/src/identity/oidc-broker.test.ts` "does not boot…, naming the parameters" |
| 2.1.3 | redirect URI registered exactly, https, no wildcard | `registeredCallbackUrl` sends the registered value, never the Host header's | `client.test.ts`, `client.telia.test.ts` "uses the registered redirect URI…" |
| 2.2, 2.7 | endpoints and keys from discovery; rotation without restart | `discoverProvider` at boot; JWKS by `jwks_uri`, refetched on an unknown `kid` | `discovery.test.ts`; telia test "picks up a rotated…" |
| 2.4.1–2.4.3 | signed request object (RS256) with `iss`=`client_id`, `aud`=issuer, `response_type`, `scope`, `client_id`, `redirect_uri`, `acr_values`, `state`, `nonce`, `jti`, `exp`, `ui_locales` | `startLogin` → `buildAuthorizationUrlWithJAR` | telia test "sends the authentication request…" (the fake verifies the signature and every claim) |
| 2.5 | `code` and `state` back; `error=access_denied` on cancel | `completeLogin` in `login.ts` → `auth_cancelled`; the attempt is claimed by its state once, before the token call (#324) | telia test "sends the person who cancels…"; `routes.test.ts` "A person who cancels at the bank…", "A return from the bank is answered once, and a failed one is spent too" |
| 2.6.1–2.6.2 | `private_key_jwt`: `iss`=`sub`=`client_id`, `aud`=token endpoint, `jti`, `exp` ≤ 60 min | `PrivateKeyJwt` with the `aud` hook; `discoverProvider` and `createTunnistusClient`'s own discovery refuse a document on Telia's host that does not offer it | telia test "authenticates the token request…", "has no client against a broker whose document…"; `discovery.test.ts` "refuses a Telia document that does not offer private_key_jwt…", `apps/api/src/boot.test.ts` "an issuer on Telia's host without private_key_jwt…" |
| 2.6.3–2.6.4 | ID token = JWE (RSA-OAEP with A128CBC-HS256, or the A128GCM Telia's metadata also lists; its header's `kid` is our enc key's thumbprint, as seen on the bed since 2026-10-08; the guide says nothing of it) around an RS256 JWS; verify the signature against the JWKS, `iss`, `aud` (array + `azp`), `exp`, `nonce`, `acr`; read the FTN claims; a token that arrives unencrypted is refused | `enableDecryptingResponses` with the key's kid and both encryptions, `enableNonRepudiationChecks`, `authorizationCodeGrant` with expected state and nonce, `identityFromClaims` | telia test "…decrypts and verifies…", "decrypts an ID token under either content encryption…", "refuses an ID token that is not encrypted…", "refuses a level other than…" |
| 2.6.5 | non-Finnish methods carry no personal identity code | refused as `no identity code` | telia test "…a token without the identity code" |
| Traficom 213/2023 S | `acr_values` mandatory; the answer's `acr` is the one asked for | `OIDC_ACR_VALUES`, trimmed, a blank one refused; `createTunnistusClient` refuses a Telia issuer without a level and sends the levels trimmed; `expectedAcr` | `client.test.ts` "accepts only the level…"; `client.options.test.ts` "does not start in the Telia dialect with acrValues …"; `apps/api/src/lib/config.test.ts` "trims the level asked of the bank…"; both provider tests |
| rules 1 and 3 | the code becomes an HMAC and a year and month, nothing else is kept | `deriveIdentity`, `deriveFromBroker` | `hetu.test.ts` (fast-check), `routes.test.ts` "A first login…", `pii-in-logs.test.ts` |
| TD-7 | re-registration at the callback | `decideRegistration` | `features/identity/re-registration.feature` |
| — | the routes, end to end | `routes.ts` | `features/identity/bank-login.feature`, `features/identity/sessions.feature` |
| plain dialect | the mock IdP over http, no request object, no client secret | same adapter, decided by the issuer: Telia's two hosts over https, in any case and with or without the default port, are the Telia dialect, anything else the plain one; the plain dialect, http or another port on Telia's host is refused | `services/mock-idp/verify.ts` (the compose job, on every pull request: the mock's claims for every persona and for somebody else, and one login through `createTunnistusClient` in the plain dialect, its typed identity checked against the persona's claims, #426); the e2e flows' logins (ADR-020); `client.mock-idp.test.ts` (the kit's, run against this repository's mock by hand; it skips itself without the mock); `discovery.test.ts` "takes the host the URL names…"; `client.options.test.ts` "does not start on Telia's host with …" |

### Read against v2.36 in full (2026-10-22, #44)

- The PDF the maintainer downloaded on 2026-10-22 is the same v2.36 of 2026-02-06 as the GitHub copy this file follows (its running header says 2.35 and its version history dates 2.36 "6.2.2025": Telia's slips, not another revision). Between v2.34 (29.10.2025) and v2.36: Handelsbanken removed from the maintenance sample (1.3), the test users (1.4) and the methods table (2.4.3); the test users' credentials updated (1.4: POP's, and the code-card option named for Säästöpankki and OmaSP); the Baltic row of 2.4.3 naming ID Card beside Smart-ID and Mobile-ID; the fingerprints of 2.2.1 the same in both. Nothing else in sections 2.4–2.7 changed, and every row of the table above holds against the text; the kit, the double and the adapter need no change for it.
- What the kit leaves out, on purpose. `max_age` (2.4.3): `prompt=login` is what ADR-016 chose, and a caller that wants `max_age` asks for it as an option. A bank chosen through `acr_values` (2.4.5, `oidc.nordea.1` and the like): the kit sends whatever `acrValues` says but accepts an answer only at a level it asked for, and the answer to a method request carries the level in `acr` and the method in `amr` (2.6.4's sample), so pre-selecting a bank would need an option that tells the two apart. The OAuth metadata at `/uas/.well-known/oauth-authorization-server`, the signed JWKS at `/openid_provider/signed_jwks.jwt` and the entity statement (2.1.2, 2.2, 2.7.2), all optional: discovery and `jwks_uri` serve the same keys. `maintenance.txt` (1.3). Non-Finnish methods (2.6.5), which need an order with Telia and carry no identity code: the kit refuses the token. The double checks five things beyond the guide, as the kit's own rule: `typ: JWT`, `exp`, `state` and `nonce` in the request object, which 2.4.3 lists as optional and the kit always sends, and no `nbf`, which the guide does not name and the kit never sends.
- Corrected the same day, from this reading: Handelsbanken in the demo personas' staging notes (removed in the guide); POP's third credential below; the JWE `kid` rule and the `amr` shapes, which were credited to the guide where they are what the bed showed and 2.4.3's list. Left as they are, for the maintainer: Mikael's and Ilona's staging notes in the personas (the bed's Ålandsbanken and S-Pankki users no longer return Mikael, #139's table below; Aktia's alternative credentials there are not in the guide).

## Pre-production test users (section 1.4)

Per bank: Nordea `DEMOUSER1`–`DEMOUSER4`; Danske `88888888` / `4545`; Aktia and OP prefilled; Ålandsbanken and S-Pankki `12345678` / `123456` / `1234` (code card); Säästöpankki and OmaSP `11111111` / `123456` (code card); POP `12345678` / `0000` / `0000 Test` (code card); Mobiilivarmenne emulator prefilled (`acr` `mpki.telia.emulator.1`). The hetu they return is a test code (for example `220750-999Y`, `141002A909X`). The published codes of the test persons (integrator documentation, 2024; verified on the bed by #139) are the identities of the demo personas of the mock bank (#140, `services/mock-idp/README.md`); of them Danske's `280453-111A` and Samlink's first person `010100A001N` fail the check character and are refused by `deriveIdentity`.

What the bed returned when each test user logged in to staging (#139, the simulator against `api.staging.kuutti.app` at `c63001f`, 08/10–10/10/2026; staging's log carries every completed login as one line with `acr` loatest2, the bank as `amr` and the outcome):

| bank, user | code returned | birth | Kuutti's answer |
|---|---|---|---|
| Nordea `DEMOUSER1` | Onni's | 1.2.2000 | completed (resumed: a member) |
| Nordea `DEMOUSER2` | Aino's | 29.12.1992 | completed (resumed: a member) |
| Nordea `DEMOUSER3` | Noa's | 3.8.1983 | completed (resumed) |
| Nordea `DEMOUSER4` | Sanna's | 17.6.1977 | completed (resumed) |
| Säästöpankki `22222222` / `123456` | `010280-952L` (Kerttu's) | 1.2.1980 | completed (asked to accept the terms again) |
| OP, prefilled, key code 1234 | Tapio's | 7.7.1970 | completed (resumed: a member) |
| Aktia, prefilled | `010170-999R` (Ilona's) | 1.1.1970 | completed (resumed: a member) |
| Ålandsbanken `12345678` / `123456` / `1234` | `410165-012D` | 1.2.1980 | refused: not a valid code (day 41) |
| S-Pankki `12345678` / `123456` / `1234` | `750240-1228` | 1.2.1980 | refused: not a valid code (day 75) |
| Danske `88888888` / `4545` | `010108-000Z` | 1.1.1908 | refused: not a valid code (individual number 000) |
| Mobiilivarmenne emulator, `0401234567` | `010132-998W` | 1.1.1932 | completed (resumed: Helmi, a member still without photos) |

The codes and the births are what the bed returned in October. The last column is what the personas' stories make of each since 21/11/2026 (#560, the maintainer): every test user whose code the parser accepts is a member with a profile, so a reviewer of a store or a tester lands in the app whichever of them they type, and nobody who signs in through the bed lands in the sign-up steps. Until then `DEMOUSER1` started onboarding from its first step, OP's user was refused as banned and Aktia's as deleted, by the stories of that time; those states are now on people of the mock bank alone (`services/mock-idp/README.md`). The new answers are the stories' tests', not yet a walk on the bed.

Two things changed on the bed since the published list: Danske now returns `010108-000Z` (not `280453-111A`), and Ålandsbanken and S-Pankki return codes with impossible days, so neither is Mikael (`010170-960x`) any more; the mock bank's Mikael has no working test user on staging. Every refusal of an invalid code reaches the person as the sign-in card's title, "Sign-in did not complete", over Try again (#581), which promises a retry that cannot help.

## What the design rests on

What the guide does not say in so many words, and how the design holds without it. These decide #34 and the privacy notice.

| question | why it matters | what holds |
|---|---|---|
| Which identifier answers a **police request** (hetu, `sub`, `session_index`, bank id), and against what record? | our police-traceability line and the erasure table | What Kuutti holds of a login is `session_index`, `auth_time` and the method (`amr`); the police bring the person. Whether Telia's logs answer by `session_index` is open, the maintainer's to settle with Telia (`docs/runbooks/police-disclosure.md`). |
| Is **`sub` stable** per person across banks, across time, and between pre-production and production, and is it pairwise per client? | whether `sub` may be stored as an identifier or only as the event reference (#34) | The design does not rely on it: the identity is keyed by `hetu_hmac`, and `identity.broker_subject` is one login's reference, worth nothing across logins. Pairwise: no, `subject_types_supported: ["public"]` |
| What does the broker **retain** of an identification event, and for how long? | the privacy notice must say what a third party keeps | Five years, the broker's own obligation, not ours (`docs/runbooks/sunset.md`). |
| Do pre-production `sub` values and test hetus ever appear in production? | so staging data can never be mistaken for a person | By structure: the two environments are separate issuers, and the test users' codes that pass the parser have individual numbers 900 to 999, which the population register gives nobody (ADR-014 §3), and the rest (Ålandsbanken's, S-Pankki's and Danske's since #139, the table above) fail the date or the check character, so none of them can be a person either. |
| Which `acr` and `amr` values tell a bank login from Mobiilivarmenne, and what is the signing-key rotation schedule? | the log line per login names the method; rotation is read from the JWKS without a restart | Guide 2.6.4 has `amr` as a method reference in URI form; the identifiers are 2.4.3's and 3.3.1's, under `/uas/saml2/names/ac/`: `oidc.<bank>.1` for the banks except Osuuspankki's `saml.op.1`, `mpki.telia.1` for Mobiilivarmenne and `mpki.telia.emulator.1` for its emulator on the bed; keys rotate per the Key Rotation note and are published in advance at `/uas/oauth2/metadata.jwks` |
| Is the `kid` in the ID token's JWE header the `kid` of the `enc` JWK we registered (its RFC 7638 thumbprint), as the Python sample assumes? | `openid-client` decrypts only with the key whose kid the header names; a kid Telia assigned itself would fail every login with `no applicable decryption key selected` | Yes: the header carries the key's own kid. Seen on the bed since 2026-10-08, when the first ID tokens decrypted with our `enc` key |
| Is the ID token encrypted to our `enc` key on the test bed too, and with which `enc` (`A128CBC-HS256` per the guide, or `A128GCM`, both in the metadata)? | the adapter refuses an ID token that arrives in the clear | Guide 2.6.3: the ID token is always encrypted with the client's public key; the sample header is RSA-OAEP with A128CBC-HS256, which the client metadata declares. Seen 2026-10-08: the tokens arrived encrypted and decrypted with the `enc` key (the `enc` value itself is not logged; the adapter accepts both) |
| Should the request object carry `prompt=login` or `max_age=0`, so a second login from the same browser within Telia's web session goes through the bank again? | otherwise `auth_time` may predate the login; an identity-flow change, so an ADR or TD citation | Decided by ADR-016: `prompt=login`, which guide 2.4.3 defines as a login page every time. Seen 2026-10-08: three logins minutes apart from one phone each went through the bank page, and the freshness check (`auth_time` no older than the attempt) passed every time |

## Custody

The agreement, the contact, and the two private keys are rows in `docs/runbooks/custody.md`. Keys are generated onto the offline medium by `infra/scripts/telia-keys.sh` and put into SSM from there (`--put`, by file reference); they never sit in a shell history, a command line, a mailbox or a chat. Only the JWKs file it writes leaves the medium, and that holds public keys.
