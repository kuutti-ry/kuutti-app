# Telia Tunnistus (Finnish Trust Network broker)

What Telia's identification broker is to us, what we owe them, what they owe us, and the answers we are still waiting for. Source: *Telia Tunnistus – Integration guide to the identification broker service* v2.36 (2026-02-06) and the *Key Rotation* note (2026-01-07), both published at https://github.com/telia-oss/tunnistus. Telia's offer of 2026-10-07 links two Salesforce files: the same guide at v2.34 (approved 29.10.2025; the viewer's title line still says v2.12) and the general terms of service (English, 19.11.2020, twelve pages). The GitHub copy is the newer one and the one this file and the tests follow. Telia's provisioning answer of 2026-10-08 came with a one-page *OIDC Relying Party Cheat Sheet* (in the association's mailbox). No credentials in this file (#32).

## The relationship

Telia Tunnistus is a contracted service, not a self-service API. The **Telia Identification Service Agreement** between the association and Telia Finland Oyj (business ID 1475607-9) must be signed before the move to production; its Appendix 4 names the **technical contact**, the one person allowed to exchange keys with Telia. The pre-production environment (`tunnistus-pp.telia.fi`) is different: Telia's offer of 2026-10-07 says it is free of charge, needs no agreement, and is provisioned within one to two working days of the metadata reaching id-maintenance. A client that passes there is moved to production (`tunnistus.telia.fi`) by Telia within one working day once the agreement is signed, and billing starts with production.

Where things stand (2026-10-07):

- The offer came from Telia's business manager for the service (the thread is in the association's mailbox) and is valid thirty days. The price list is in the association's mailbox, not here. Kuutti answered the same day: the test environment now, the **S package** in production. One `SP-Name` per agreement; each further name is charged. A package change asked for before the middle of a month takes effect at the start of the next.
- Telia's CRM did not yet know Kuutti ry; the agreement is expected for review on **19.10.2026**. The test bed does not wait for it.
- No support or discount programme for non-profits at Telia. The other FTN brokers Telia named, should the association want to ask them: Idura, OP, In Groupe (Nets), Signicat, Elisa, Nordea.
- Contacts: provisioning, metadata and technical questions, **id-maintenance@teliacompany.com**; faults 24/7, 0200 20 300; the commercial contact is in the offer thread.
- **2026-10-08: the test connection exists** (Telia ticket 01121315, answered the morning after the request). `client_id` `b9b08a7a-ebb4-4a8c-a3e7-52824d3231e5`, redirect URI `https://api.staging.kuutti.app/auth/callback`; the id is the default of `telia_client_id` in `infra/envs/staging/variables.tf`. With the answer came Telia's one-page *OIDC Relying Party Cheat Sheet*: the request carries `request=` only and extra query parameters are discarded; the code is passed through untouched; Telia's signing key can also be taken from its signed JWKS behind the entity statement (not used; discovery's `jwks_uri` serves the same keys).

Sales entry, for the record: https://www.telia.fi/yrityksille/palvelut/tietoturva/tunnistautuminen (*Telia Tunnistus*, "ota yhteyttä").

## What Telia needs from us (guide section 2.1)

| item | ours |
|---|---|
| public keys, RSA 2048 or longer, **two separate JWKs**: `"use": "sig"` (signs our request objects and client assertions) and `"use": "enc"` (Telia encrypts the ID token to it) | generated per `infra/README.md` Secrets; the private halves live in SSM `/kuutti/<env>/telia-signing-key` and `/kuutti/<env>/telia-encryption-key`; the public JWKs go to Telia by e-mail (an OpenID Federation entity statement is the alternative; not used yet) |
| redirect URIs, HTTPS, **no wildcards** | staging `https://api.staging.kuutti.app/auth/callback`; production `https://api.kuutti.app/auth/callback` (#25). Pull-request previews cannot be registered, so they stay on the mock IdP |
| display name `ftn_spname`, at most 40 characters, shown to the user during login | `Kuutti` |
| technical contact (Appendix 4) | the maintainer, with the project mailbox in copy |

Production keys are confirmed through Telia's e-signature service: the technical contact signs the offered keys (or the entity statement) with strong identification.

### The test-bed request

What the offer asks for, in one mail from the project mailbox to id-maintenance@teliacompany.com:

1. Protocol: **OIDC**, with `private_key_jwt`, signed request objects and the encrypted ID token (guide 2.4–2.6). Pre-production first.
2. `ftn_spname`: **Kuutti**, shown as "Tunnistuspyyntö 12345, lähettäjä Kuutti".
3. The client metadata, `kuutti-staging-telia-client.json`, written by `infra/scripts/telia-keys.sh staging <offline-medium>` in the shape of the Python sample's `client.json` (`KUUTTI_TELIA_CONTACT` supplies the contact address, so none is in the repository): the redirect URI `https://api.staging.kuutti.app/auth/callback` (Telia's whitelist; only that one for pre-production, since production's `https://api.kuutti.app/auth/callback` is registered with the production client and its own keys), `client_name#fi/sv/en` and `ftn_spname`, the organisation and contact, the algorithms (`private_key_jwt`, RS256 request objects and ID tokens, `RSA-OAEP` with `A128CBC-HS256`), and the two public keys as JWKs: `use: sig` (signs request objects and client assertions) and `use: enc` (the ID token is encrypted to it). The offer's wording mentions one key pair for `private_key_jwt`; the guide (2.1.1, 2.6.3) has two, and the API refuses an ID token that arrives in the clear, so the mail says which key is which and asks Telia to confirm that the ID token is encrypted to the `enc` key.
4. The two questions the guide and the discovery document do not answer (confirmations table below): the JWE header's `kid`, and `sub` stability over time together with the reference for a section 24 lookup. The rest of the table is answered by the guide or verified at the first login; asking it would only say we had not read it.

Registered kids, staging, generated 2026-10-07 (public values; the API logs the same two at boot): `sig` `h3459Y74bDyIP_F8RPGkACWjOouvJzgdw0vGtZ9bi7I`, `enc` `faflNFy64dbC2qZ25QUUPN1bfBePnOpcJAaUfV3l-QQ`. The three staging secrets exist in SSM since the same day (`telia-signing-key`, `telia-encryption-key`, `hetu-hmac-key`).

Telia answers with the `client_id`. It is public (every authorization URL carries it): set it as the default of `telia_client_id` in `infra/envs/staging/variables.tf` and merge; CI's apply then writes `oidc-issuer`, `oidc-client-id`, `oidc-redirect-uri` and `oidc-acr-values` under `/kuutti/staging/`. The two private keys must be in SSM before that (`telia-keys.sh … --put`): the API refuses to boot against a Telia issuer without them. Redeploy the API in Dokploy and read the boot line "bank identification": the two kids it logs must equal the kids of the JWKs Telia registered. A pull-request preview never gets any of this: `parseConfig` drops the Telia client, both keys and the HMAC key from a preview's configuration (ADR-014 §1).

The first login on the test bed (2026-10-08) showed what was left to watch: `acr` came back as `loatest2` (the adapter accepts the level asked for, so a login that completes proves it), `prompt=login` sent each attempt through the bank with a fresh `auth_time` (ADR-016's check passed), the JWE header's `kid` was ours, and the outer query of `client_id` and `request` was accepted (the cheat sheet: `request=` is read, anything else discarded).

## What Telia gives us

- `client_id` (generated by Telia at registration) and the endpoints:
  pre-production issuer `https://tunnistus-pp.telia.fi/uas`, discovery `/uas/.well-known/openid-configuration`, authorization `/uas/oauth2/authorization`, token `/uas/oauth2/token`, JWKS `/uas/oauth2/metadata.jwks`, entity statement `/.well-known/openid-federation`; production the same under `https://tunnistus.telia.fi`.
- Checked live on 2026-10-07: both hosts' discovery documents name exactly these endpoints, offer `private_key_jwt`, RS256 for request objects and ID tokens, and encrypt ID tokens with `RSA-OAEP` and `A128GCM` or `A128CBC-HS256` (the adapter accepts both since then); neither publishes `acr_values_supported` or `ui_locales_supported`. The pre-production JWKS carries one `sig` and one `enc` key.
- Telia's signing keys rotate on Telia's schedule; the next keys are published in the metadata endpoints in advance (Key Rotation note, guide 2.7.1).
- Production disruptions are announced at `https://tunnistus.telia.fi/uas/resource/maintenance.txt`, one line in three languages separated by `|` (guide 1.3); nothing reads it yet. The API reads the JWKS by URL and pins nothing: `openid-client` keeps the set for five minutes and fetches it again when a token names a `kid` it does not hold (once the cached set is a minute old), so a key published in advance is used without a restart. The entity statements' SHA-256 fingerprints in the guide allow out-of-band checks.

## The flow as Telia specifies it (section 2.4–2.6)

- Authorization request as a **signed request object** (RFC 9101, RS256 with our `sig` key): `iss` = client_id, `aud` = the issuer, `response_type=code`, `scope=openid`, `redirect_uri`, `state`, `nonce`, `jti`, `exp` (about 10 minutes), `ui_locales` (`fi`, `sv`, `en`), and **`acr_values`**, mandatory under the Traficom recommendation 213/2023 S: `http://ftn.ficora.fi/2017/loa2` in production, `http://ftn.ficora.fi/2017/loatest2` in pre-production (`OIDC_ACR_VALUES`).
- Token request with **`private_key_jwt`** (RFC 7523): `iss` = `sub` = client_id, `aud` = the token endpoint, `jti` single-use, `exp` within 60 minutes.
- The **ID token is a JWE** (RSA-OAEP, A128CBC-HS256) encrypted to our `enc` key and, inside, a JWT signed by Telia (RS256): decrypt, then verify `iss`, `aud`, `exp`, `nonce`, `acr`.
- A person who backs out at the bank comes back with `error=access_denied` and no code (guide 2.5.2); the API sends them into the app as `auth_cancelled`, not as a failure.
- Claims for a Finnish user through an FTN method: `sub` (opaque), `auth_time`, `acr`, `amr` (the bank, as a URI such as `https://tunnistus-pp.telia.fi/uas/saml2/names/ac/oidc.aktia.1`), `urn:oid:1.2.246.21` = **hetu**, `urn:oid:1.3.6.1.5.5.7.9.1` = date of birth, `urn:oid:2.5.4.4` surname, `urn:oid:1.2.246.575.1.14` given names, `urn:oid:2.16.840.1.113730.3.1.241` display name, `bank-tupasid`, `session_index`. The API keeps `sub`, `auth_time`, `acr`, `amr` and the identifiers it derives (`hetu_hmac`, `birth_year`, `birth_month`); the rest is read and dropped (rules 1 and 3).

The mock IdP in `services/mock-idp` issues the same claim names and `acr`/`amr` shapes, so local development exercises the real parser. The Telia dialect itself (request object, `private_key_jwt`, the JWE) is exercised against `apps/api/src/test/fake-telia.ts`, an in-process provider written to the guide under the real pre-production issuer; see Conformance below.

## Conformance: guide clause → code → test

What the guide requires, where the API does it, and which test proves it. Levels, as agreed: pure functions with property or example tests; the adapter against a provider written to the guide (in process); the routes end to end on real Postgres with a broker double; the plain dialect against the real mock IdP in the compose job; the whole thing by hand against the mock. On 2026-10-08 the whole of it ran against Telia's pre-production bed: the first complete login (Aktia's test person) went through the signed request object, the chooser, the encrypted ID token, the freshness check of ADR-016 and the identity derivation, and ended with a session on the phone (#32, #33).

| guide | requirement | code | test |
|---|---|---|---|
| 2.1.1, 2.3 | two RSA keys, `sig` and `enc`, 2048+ | `infra/README.md` Secrets; `OidcBroker.create` refuses a Telia issuer without both | `oidc-broker.telia.test.ts` "does not boot…" |
| 2.1.3 | redirect URI registered exactly, https, no wildcard | `registeredCallbackUrl` sends the registered value, never the Host header's | `oidc-broker.test.ts`, `oidc-broker.telia.test.ts` "uses the registered redirect URI…" |
| 2.2, 2.7 | endpoints and keys from discovery; rotation without restart | `discoverProvider` at boot; JWKS by `jwks_uri`, refetched on an unknown `kid` | `discovery.test.ts`; telia test "picks up a rotated…" |
| 2.4.1–2.4.3 | signed request object (RS256) with `iss`=`client_id`, `aud`=issuer, `response_type`, `scope`, `client_id`, `redirect_uri`, `acr_values`, `state`, `nonce`, `jti`, `exp`, `ui_locales` | `startLogin` → `buildAuthorizationUrlWithJAR` | telia test "sends the authentication request…" (the fake verifies the signature and every claim) |
| 2.5 | `code` and `state` back; `error=access_denied` on cancel | `completeLogin` in `login.ts` → `auth_cancelled` | telia test "sends the person who cancels…"; `routes.test.ts` "A person who cancels at the bank…" |
| 2.6.1–2.6.2 | `private_key_jwt`: `iss`=`sub`=`client_id`, `aud`=token endpoint, `jti`, `exp` ≤ 60 min | `PrivateKeyJwt` with the `aud` hook | telia test "authenticates the token request…" |
| 2.6.3–2.6.4 | ID token = JWE (RSA-OAEP with A128CBC-HS256, or the A128GCM Telia's metadata also lists; `kid` = our enc key's thumbprint) around an RS256 JWS; verify the signature against the JWKS, `iss`, `aud` (array + `azp`), `exp`, `nonce`, `acr`; read the FTN claims; a token that arrives unencrypted is refused | `enableDecryptingResponses` with the key's kid and both encryptions, `enableNonRepudiationChecks`, `authorizationCodeGrant` with expected state and nonce, `identityFromClaims` | telia test "…decrypts and verifies…", "decrypts an ID token under either content encryption…", "refuses an ID token that is not encrypted…", "refuses a level other than…" |
| 2.6.5 | non-Finnish methods carry no personal identity code | refused as `no identity code` | telia test "…a token without the identity code" |
| Traficom 213/2023 S | `acr_values` mandatory; the answer's `acr` is the one asked for | `OIDC_ACR_VALUES`; `expectedAcr` | `oidc-broker.test.ts` "accepts only the level…"; both provider tests |
| rules 1 and 3 | the code becomes an HMAC and a year and month, nothing else is kept | `deriveIdentity`, `deriveFromBroker` | `hetu.test.ts` (fast-check), `routes.test.ts` "A first login…", `pii-in-logs.test.ts` |
| TD-7 | re-registration at the callback | `decideRegistration` | `features/identity/re-registration.feature` |
| — | the routes, end to end | `routes.ts` | `features/identity/bank-login.feature`, `features/identity/sessions.feature` |
| plain dialect | the mock IdP over http, no request object, no client secret | same adapter, decided by the issuer | `oidc-broker.mock-idp.test.ts` (compose job), `services/mock-idp/verify.ts` |

## Pre-production test users (section 1.4)

Per bank: Nordea `DEMOUSER1`–`DEMOUSER4`; Danske `88888888` / `4545`; Aktia and OP prefilled; Ålandsbanken and S-Pankki `12345678` / `123456` / `1234` (code card); Säästöpankki and OmaSP `11111111` / `123456`; POP `12345678` / `0000`; Mobiilivarmenne emulator prefilled (`acr` `mpki.telia.emulator.1`). The hetu they return is a test code (for example `220750-999Y`, `141002A909X`).

## The four confirmations we need in writing

Asked of Telia at onboarding; the answers decide #34 and the privacy notice. The maintainer put the first four to the commercial contact on 2026-10-07; that side answered the retention question and sent the rest to id-maintenance, so they go into the test-bed request above. Fill in the date and the answer.

| question | why it matters | answer |
|---|---|---|
| Which identifier does Telia answer a **police request** with (hetu, `sub`, `session_index`, bank id), and against what record? | our police-traceability line and the erasure table | 2026-10-07: the logs are opened on a police request only. 2026-10-08, implicitly: `sub` is useless for it ("transient"); what we hold of a login is `session_index`, `auth_time` and the method (`amr`), and the police bring the person. Whether Telia searches its logs by `session_index` was not answered in so many words; ask again when the agreement is signed |
| Is **`sub` stable** per person across banks, across time, and between pre-production and production, and is it pairwise per client? | whether `sub` may be stored as an identifier or only as the event reference (#34) | **2026-10-08, id-maintenance: `sub` is transient and is not to be used for identification; the personal identity code is.** Which is the design: the identity is keyed by `hetu_hmac`, and `identity.broker_subject` is one login's reference, worth nothing across logins. Pairwise: no, `subject_types_supported: ["public"]` |
| What does the broker **retain** of an identification event under section 24 of the Act on Strong Electronic Identification, and for how long? | the privacy notice must say what a third party keeps | 2026-10-07, Telia's commercial contact: Traficom has every FTN broker keep the logs **five years**; they are cleared from the platform and kept in a sealed environment, accessible on a police request only |
| Do pre-production `sub` values and test hetus ever appear in production, and are test users' events retained the same way? | so staging data can never be mistaken for a person | Answered by structure: the two environments are separate issuers, and the test users' codes have individual numbers 900 to 999, which the population register gives nobody (ADR-014 §3). Not asked |
| Which `acr` and `amr` values tell a bank login from Mobiilivarmenne, and what is the signing-key rotation schedule? | the log line per login names the method; rotation is read from the JWKS without a restart | 2026-10-07: referred to the guide. Guide 2.6.4: `amr` carries the method as a URI under `/uas/saml2/names/ac/` (`oidc.<bank>.1`, `mpki.telia.1`); keys rotate per the Key Rotation note and are published in advance at `/uas/oauth2/metadata.jwks` |
| Is the `kid` in the ID token's JWE header the `kid` of the `enc` JWK we registered (its RFC 7638 thumbprint), as the Python sample assumes? | `openid-client` decrypts only with the key whose kid the header names; a kid Telia assigns itself would fail every login with `no applicable decryption key selected` | **2026-10-08, id-maintenance: Telia assigns no kid; the header carries the key's own kid.** Seen the same day: the first ID tokens decrypted with our `enc` key |
| Is the ID token encrypted to our `enc` key on the test bed too, and with which `enc` (`A128CBC-HS256` per the guide, or `A128GCM`, both in the metadata)? | the adapter refuses an ID token that arrives in the clear; the offer's wording mentions only the signing key | Guide 2.6.3: the ID token is always encrypted with the client's public key; the sample header is RSA-OAEP with A128CBC-HS256, which the client metadata declares. Seen 2026-10-08: the tokens arrived encrypted and decrypted with the `enc` key (the `enc` value itself is not logged; the adapter accepts both) |
| Should the request object carry `prompt=login` or `max_age=0`, so a second login from the same browser within Telia's web session goes through the bank again? | otherwise `auth_time` may predate the login; an identity-flow change, so an ADR or TD citation | Decided by ADR-016: `prompt=login`, which guide 2.4.3 defines as a login page every time. Seen 2026-10-08: three logins minutes apart from one phone each went through the bank page, and the freshness check (`auth_time` no older than the attempt) passed every time |

## Custody

The agreement, the contact, and the two private keys are rows in `docs/runbooks/custody.md`. Keys are generated onto the offline medium by `infra/scripts/telia-keys.sh` and put into SSM from there (`--put`, by file reference); they never sit in a shell history, a command line, a mailbox or a chat. Only the JWKs file it writes leaves the medium, and that holds public keys.
