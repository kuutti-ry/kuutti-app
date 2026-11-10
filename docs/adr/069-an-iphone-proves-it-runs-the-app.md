# ADR-069: An iPhone proves it runs the app: App Attest at the exchange and at every refresh

- Status: proposed (#580, on the maintainer's word of 2026-11-10 in chat: build what can be detected now, without waiting for ADR-056's other two triggers, and update it closer to the release; the API's half is built as written here; the app's half, Android and production's switch wait, see Not built here and Open; accepting it is the maintainer's)
- Date: 2026-11-10
- Follows: TD-1 (every account is one bank-verified person, and a session is a device's), TD-6 (what one person can take in is counted, and a verified person can capture what they are shown), ADR-056 (§1's third trigger came with ADR-062; §2's shape, carried out and amended here), ADR-027 (the exchange, §3 amended here; the door it leaves open), ADR-058 and ADR-059 (the refresh; ADR-059 §3 and §6 amended here), ADR-041 and ADR-062 §9 (the alarms that stand meanwhile), ADR-004 §4 (update signing has not returned), ADR-021 (the levels of tests), CLAUDE.md's Decisions (a change to identity) and Security defaults; issues #580, #86, #184, #25

## Context

Since the queue (ADR-062) a person reads as many cards as they like, and so does a script signed in with that person's own bank login. That was the third of ADR-056 §1's triggers, and #580 is where the maintainer decides when the attestation of ADR-056 §2 starts. On 10/11/2026 he said: build what can be detected now, do not wait for the other two triggers, and update it closer to the release if need be.

**What can be told, and what cannot.** Three questions are easily taken for one.

- *Is this request from our app?* An attestation answers it. On an iPhone it answers well: the key that signs is made in the phone's Secure Enclave, and Apple certifies that an app with our App ID on a real Apple device made it. On Android nothing answers it yet (§6, Not built here).
- *Is a person operating the app?* Nothing answers it. A script that drives the real app on a real phone, a device farm and an AI agent tapping through the screens all attest truthfully (ADR-056, What attestation does not touch). They use the interfaces VoiceOver and Switch Control use, so anything that looked for them would find blind and motor-impaired people first. What bounds them is what bounds a person: one account per bank identity, hard filters that hold in both directions, the pace of a screen, and the alarms on amounts.
- *Is the account's owner the one acting?* The bank login says so at sign-in, and the app lock at an unlock (ADR-045). Nothing says so between.

So this record is about the first question alone.

**What a script does today.** It needs no phone. It opens the sign-in itself, the person completes the bank login in a desktop browser, and the script exchanges the code with a verifier of its own (ADR-027, What it does not close). Or it reads the tokens of a real sign-in off the phone through a proxy the owner trusts (ADR-056, How a token is read) and refreshes them itself.

**The vendors' documents, read again on 10/11/2026.**

- Apple, "Validating apps that connect to your server": eleven steps for an attestation and eight for an assertion. Steps 10 and 11 of the first read two extensions that iOS 27 adds to the authenticator data: how the app was launched (`apple_validation_category_01`: 2 TestFlight, 3 a development signature, 4 the App Store, 5 ad hoc or enterprise, 0 invalid, 7 to 9 "not appropriate") and its bundle version.
- Apple, "Attestation Object Validation Guide": a whole attestation with the value each step should give, made by an app that passed the challenge's bytes themselves as the client data hash. It verifies under Apple's root only inside the three days of its credential certificate.
- Apple's root, "Apple App Attestation Root CA", from `https://www.apple.com/certificateauthority/private/`: valid until 15/03/2045.
- Expo's `@expo/app-integrity` 57.0.2 (MIT, the `sdk-57` tag, no install script, not among SDK 57's bundled modules): `isSupported`, `generateKeyAsync`, `attestKeyAsync(keyId, challenge)` and `generateAssertionAsync(keyId, challenge)`. Both take a string and hand Apple the SHA-256 of its UTF-8 bytes as the client data hash, and both answer base64. On Android it offers Play Integrity and, without Play, a hardware-attested Keystore key with its certificate chain, but no way to sign with that key.

## Decision

1. **What is proven.** A session of an iPhone is bound to a key that lives in that phone's Secure Enclave and that Apple certified as made by an app with Kuutti's App ID. That says the real app on a real device is signing in and refreshing. It says nothing of who or what taps.

2. **At the exchange.** `POST /auth/exchange` takes, beside the code and its verifier, an optional `attestation`: the key's identifier and the attestation object, both in base64 (`AppAttestation`, `packages/schema/src/identity.ts`). This amends ADR-027 §3, whose body was exactly the two.
   - **The challenge is the one-time code.** The app asks Apple for the attestation with the code's characters, so the client data hash is their SHA-256. The code is the server's, random, single use and sixty seconds old at most, so an attestation made over one code is refused with any other, and no second request is needed to fetch a challenge.
   - **It is verified before the code is spent**, by Apple's eleven steps (`verifyAttestation`, `apps/api/src/identity/app-attest.ts`):
     1. the certificates lead to Apple's root, each issued and signed by the next, every issuer an authority, and all of them valid at that moment;
     2. to 4. the credential certificate's nonce is the SHA-256 of the authenticator data and the client data hash;
     5. the key identifier is the SHA-256 of the certified key, which is on P-256;
     6. the authenticator data name our App ID: `IOS_TEAM_ID`, a period and the bundle identifier;
     7. the counter is 0;
     8. the key is of Apple's production environment, or of its development environment anywhere but in production;
     9. the credential is the key identifier;
     10. the launch category is none of 0, 7, 8 and 9, when the phone says one;
     11. the bundle version is read, and pinned to nothing.
   - Steps 10 and 11 refuse little on purpose. The App ID already says the build is signed by the association's team, so the category only says how it reached the phone, and what Apple's reviewers' builds say is not documented. Both values go to the log (below), so that the release can be judged on what real builds say. The nonce covers these bytes, so a shape this code does not know is Apple's newer one and not an attack: it reads as nothing said and refuses nobody.
   - **A refusal** answers 403 `attestation_refused` and leaves the code unspent, as a wrong verifier does. This is a second refusal beside ADR-027's `auth_code_used`. It tells only what the sender knows: the attestation is theirs.
   - **One statement still spends the code** (`consumeAppCode`). An attempt that said `ios` is spent without an attestation only where none is required (§5), and an attempt that said anything else is never spent with one: an attestation is Apple's. Where one is required and none came, a second read tells that case from a bad code, asked with the code and its verifier so that it answers nothing to anybody who could not have spent the code.
   - **The session keeps** the key's public half, an X9.62 point in base64 (`session.attest_key`, unique: a key belongs to one session), and a counter of 0 (`session.attest_counter`). A check holds the two to being set together. Nothing else of the attestation is kept: not the object, not the certificate, not the receipt.
   - **One line** says `session issued` with the account, the platform, whether it was attested, whether an attestation came and was left unread (§5), and Apple's category and bundle version. Nothing of the key reaches a log, and the logger's net redacts the fields by name.

3. **At every refresh.** `POST /auth/refresh` takes an optional `assertion` in base64. This amends ADR-059 §3 and §6.
   - **A session that keeps a key rotates only with that key's assertion over the refresh token it presents.** The refresh token is what ADR-056 §2 asked for, "a challenge that the previous refresh returned": the server made it, it is random, and it is spent by the request that presents it. So no challenge of its own is stored or returned.
   - **Verified by the first six of Apple's eight steps** (`verifyAssertion`): the signature over the SHA-256 of the authenticator data and the client data hash, by the kept key; our App ID; a counter past the one kept. Steps 7 and 8, the category and the bundle version in an assertion, are not acted on: the key was judged when it was attested.
   - **The counter moves in the rotation's own statement** (`rotateSession`), which rotates a keyed session only with a counter past the kept one. A session with no key takes none.
   - **A missing or refused assertion** answers 401 `session_revoked`, as every refused refresh does, and leaves the row as it is. So a holder of a lifted token cannot renew with it, and the phone's own next refresh still works. What such a holder can still do is end the session: a retired token of the session, or one made up around its secret part, ends it for every holder (ADR-059 §4), with an assertion or without. That rule is unchanged here (Open 5).
   - **A session with no key is refreshed as before**, and an assertion beside it is not read.
   - So a refresh token lifted from an attested iPhone is worth the access token that came with it: fifteen minutes.

4. **The verifier is ours, on `node:crypto` alone.** About three hundred lines, with a reader of the CBOR these two objects are made of and a reader of DER that reaches the one extension Node does not expose. Both refuse what they do not expect (a tag, a float, an indefinite or 64-bit length, a length past the end, a nesting past six) so that no input reads or loops beyond its own bytes. Apple's root is a constant in the file, held to its SHA-256 fingerprint by a test. The tests hold the verifier to bytes nobody here made (ADR-021's contract level): Apple's worked example, and a real iPhone's attestation and first assertion from iOS 14.4 (the test resources of `veehaitch/devicecheck-appattest`, Apache-2.0, credited in `apps/api/src/test/app-attest-samples.ts`). Every refusal is met on purpose by a test authority and a test phone (`apps/api/src/test/app-attest.ts`).

5. **The environment's switch.**
   - With `IOS_TEAM_ID` set, an attestation that comes is verified. With it unset there is no App ID to hold one to, so one that comes is left unread and its session is as any without.
   - `IOS_ATTESTATION=required` also refuses an iPhone's exchange that carries none. It is taken in staging and production only: the configuration refuses it in development and test, where simulators, the demo tools, the flows and the load smoke sign in with nothing to attest. That is ADR-056 §2's exemption by environment, never on the client's word. It needs the team id, or the process does not start. A preview reads staging's parameters, so it drops whatever staging says here and asks for nothing: it has no bank login to ask at, and must still start on the day staging requires.
   - **Unset, it is `optional` everywhere, production included.** This amends ADR-056 §2, which had production refuse by itself. Requiring is a step of the release, taken once a store build has attested against staging: a production that requires what no released build sends locks every iPhone out, and Apple's attestation service is a dependency of every new sign-in (Consequences), so the switch must come off again without a deploy.
   - **`IOS_ATTESTATION=off` reads nothing of App Attest**: an attestation that comes is left unread, and a session that keeps a key is refreshed without its assertion, its key and counter kept for the day the switch is back. It is the way out, without a deploy, when assertions fail for a reason that is no attack (a fault in the app's half, a change of Apple's): otherwise every attested phone would be sent to the bank, a billed login, each time its fifteen minutes ran out.
   - The boot says the mode and the team in one line.

6. **What the platform's word is worth.** The server knows that an attempt is an iPhone's from what the client said at the start. A script says `android`. So requiring an attestation makes the `ios` label true and no more: a script is not refused, it is one of the sessions with no key, which today is every Android phone. The label starts to tell scripts from phones on the day Android has an attestation of its own. Then the sessions with no key are few, and ADR-041's rules can count them more strictly (ADR-056 §2). Neither is built here.

7. **Personal data.** The key and its counter are the session's: they go with it at erasure and at the sweep, and no route answers them. The export says of each device whether it was attested, never the key (`AccountExport.sessions[].attested`). The phone, not the API, talks to Apple, once per sign-in, and an attestation is anonymous (ADR-056 Context); the API sends Apple nothing and asks for no fraud metric.

## Consequences

- With the app's half shipped and the switch on, nothing but the real app on a real iPhone holds a session that says `ios`, and a token read off such a phone stops working within fifteen minutes. The door ADR-027 names, a sign-in a desktop script starts, is closed for `ios` and open for `android`.
- A new sign-in on an iPhone then needs Apple's attestation service once, inside the code's sixty seconds. If Apple does not answer, the person signs in again. Where an attestation is required, that try has already been to the bank, because the code is its challenge: a trip for nothing, and one more completed identification on Telia's invoice, which counts those alone (`docs/vendors/telia.md`: 0.05 to 0.20 euros each past the package). Sessions that exist keep refreshing: an assertion is made on the phone.
- An App Attest key does not survive a reinstall or a restore to another phone. Tokens that did survive are refused at their next refresh, and the person signs in through the bank again.
- While updates are unsigned (ADR-004 §1), the real iOS binary may run JavaScript its owner serves it, and Apple would vouch for it (ADR-056 Context). Requiring an attestation in production means most after signing returns.
- A refresh that carries an assertion costs one more read. An exchange refused for want of an attestation costs one more.
- No new dependency in the API, and nothing here moves the app's fingerprint. The app's half will.
- A slowed script signed in as an Android phone is where it was: under the alarms of ADR-062 §9, which the maintainer accepted on 01/11/2026.

## Not built here, and what would make it needed

- **The app's half**, in two parts, because a merge to `main` that moves the app's fingerprint starts a development build by itself (`eas-build.yml`), and this work is to start none (Open 2). The first part is JavaScript alone: the attestation at the exchange, the assertion at the refresh, and the refusal's text in three languages, reaching for Expo's native module by its name and doing without where a build does not hold it. It moves no fingerprint, and follows this change. The second is the two lines that put the module in a build: `@expo/app-integrity` 57.0.2 among the app's dependencies and the App Attest entitlement in `app.json`. They belong to the native batch (#184). Until a build carries both, nothing sends an attestation and everything above waits.
- **Android.** Play Integrity needs Kuutti on Google Play. A hardware-attested Keystore key needs neither Play nor a module of our own, since Expo's module makes one and hands over its certificates: a fresh key attested over each refresh token would stand where an assertion stands, with no signature needed. It is a second verifier, against Google's roots and their revocation list, and its own record (Open 1).
- **Counting sessions with no key more strictly** (ADR-056 §2): after Android, for the reason of §6.
- **Apple's receipt and fraud metric** (the number of keys a device attested): the API would become a caller of Apple's servers for a number nothing here reads.
- **A check that a person is present**, such as a Face ID step after so many cards. It says a person touched the phone once, not who reads the screen after, and it would change answers for people an alarm only suspects (ADR-033).
- **An alarm over a day or a week** for the slowed script: ADR-062 Open 3 leaves the alarms' values to the first months' counts, and at the opening every honest reader reads the whole pool.

## Open, the maintainer's

1. Whether Android gets the hardware-attested key before Kuutti is on Play (ADR-056 §1's second trigger named a module of our own; Expo's now suffices).
2. Answered 2026-11-10 (the maintainer, in chat): the next build carries it, and this work starts no build of its own. So the app's half is written to move no fingerprint, and the module and the entitlement go in with the native batch (#184; Not built here).
3. When production's switch goes on: after a store build has attested on staging, and after update signing returns. With it, Mac availability off in App Store Connect (ADR-056 §2), since App Attest serves no iPhone app on a Mac before macOS 27 (ADR-056 Context).
4. The privacy notice's line: on an iPhone the app asks Apple to certify a key at sign-in, and Kuutti keeps the key's public half with the session. Its wording is his, on the site, and whether it is "strictly necessary" under ePrivacy Art. 5(3) belongs to the legal texts' review.
5. Whether a refused assertion should end the session after all (Alternatives). And the other way: whether a session with a key should stop ending when a retired or made-up token of it comes from a caller who cannot assert. Today ADR-059 §4 lets the holder of a lifted token sign the owner out, at the price of one bank login for the owner; ignoring such a caller would end that, and would also let a thief who replayed a captured token with its assertion go unnoticed.
6. Whether the attestation should be made before the bank instead, over the attempt's own challenge (the hash of its verifier, ADR-027). A failure of Apple's would then send nobody to the bank for nothing, and Apple's round trip would not run against the code's sixty seconds. The price: the challenge would be the phone's and not the server's, so what stops an attestation from being used twice would be that a key belongs to one session, for as long as that session's row is kept; and the attestation, some six kilobytes, would have to outlive the trip to the bank on the phone, past what its secure store is meant to hold. The money is small either way (Consequences). ADR-056 §2 asked for a challenge of the server's, so the order stays as built unless he says otherwise.

## Alternatives considered

- **A library for the verification.** ADR-056's research found that both Node libraries skip the certificates' dates and iOS 27's extensions. It would be a dependency on the sign-in path for three hundred lines.
- **A challenge of its own**, issued at the start or by a request before the exchange: a round trip, a column and a lifetime, for what the one-time code already is.
- **A challenge returned by each refresh** for the next: the refresh token is one already.
- **Ending the session on a missing or bad assertion.** A build that asserted wrongly once, through a fault of the app's half or a change of Apple's, would end every session it touched, where refusing lets the next good assertion through. It would take nothing more from the holder of a lifted token, who can end the session already (§3, Open 5).
- **Refusal wired to production** (ADR-056 §2): §5 says why it is a switch.
- **Attesting at the exchange only**: a lifted refresh token would work for ninety days at a time, up to a year (ADR-056, ADR-058).
- **Telling automation from a person by behaviour** (the timing of taps, sensors): it reaches assistive technology first, it is new personal data that needs a consent a harvester would refuse, and a machine paces itself.

## History

- 2026-11-10: written with the API's half of #580, on the maintainer's word of that day in chat. The security review of the diff found that staging's `required` would have kept every preview from starting, and that a lifted token can still end its session by ADR-059's rule, which the text had denied; §3, §5 and the Alternatives are as corrected, and `off` and Open 5 and 6 came of it. The same day the maintainer answered Open 2: the next build carries the app's half, and this work starts none. Verified that day against Apple's worked example under Apple's root and against a real iPhone's attestation and assertion. No real phone has attested against this code yet: the first is a build that carries the app's half, against staging.
