# ADR-027: The sign-in code works only on the phone that started the login

- Status: accepted (the random source of §5 is a `shortcut:` until the native batch, #184)
- Date: 2026-10-17
- Follows: TD-1 (every account is a bank login), RFC 8252 §8.1 (a native app's code can be intercepted by another app on the device), RFC 7636 (its method: a verifier kept, its hash sent ahead), ADR-016 (Telia's PKCE stays its own question), ADR-025 (the panel's host), ADR-026 §8 (a callback spends its attempt), CLAUDE.md "Decisions" (the identity flow changes); issues #186, #35 (the security review rerun of 2026-10-10, finding 1), #184

## Context

The app signs in through the system browser (`.claude/rules/mobile.md` Auth): it opens `/auth/start`, the bank identifies the person, the callback stores the hash of a one-time code on the attempt's `auth_request` row and sends the browser to `kuutti://auth?code=…`, and the app posts the code to `/auth/exchange` within 60 seconds for this device's access and refresh tokens. Until now the exchange gave the session to whoever presented the code. The app's pending mark (`markLoginStarted` in `apps/mobile/src/lib/session.ts`) keeps a code from somebody else's login out of this phone, but it does not keep this phone's code from leaving it.

On Android any installed app can declare the `kuutti` scheme. One installed later, or picked in the chooser, receives the browser's redirect after the person's bank login, posts the code, and holds the person's tokens for 90 days, while the person's own app shows `auth_code_used` or nothing at all. RFC 8252 §8.1 names this attack and answers it with PKCE. The verified links of #184 make the redirect harder to claim, but they do not take the attack away.

RFC 8252 asks for PKCE between the app and its authorization server. Here that server is our own API, and its code is our own one-time code; Telia's code never reaches the app. So this decision binds our code to the app that started the attempt. It does not touch the API's OIDC exchange with Telia.

## Decision

1. **Each attempt has its own verifier, kept with the pending mark.** Starting a sign-in, the app makes a new verifier and stores it with the pending mark: in `expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, or in memory on the web target. Reading the mark spends it, as before. A mark older than ten minutes, an unreadable one, or one in the format from before this change counts as absent. The last start wins: each tap writes a new verifier, so a code that belongs to an earlier tap is refused.

2. **The challenge is required at the start.** The challenge is the SHA-256 of the verifier's characters, written as lowercase hex, 64 characters long. The verifier is 64 lowercase hex characters too. `/auth/start` takes it as `code_challenge`, and without it, or with one of any other shape, the start is answered 400 `validation_failed` before anything is written or signed. The sign-in doors (ADR-026 §4) still run first. The challenge is stored in `auth_request.code_challenge` (nullable `text`, with no CHECK and no index). It travels in the start URL and is not a secret, so a plain database equality is enough to compare it, with no constant-time compare: the verifier is hashed before anything is compared, and the hash it is compared with is public.

3. **The exchange takes the code and its verifier, and one statement spends the code.** The body is exactly `{code, verifier}` (strict). A missing or malformed verifier is answered 400 `validation_failed` before any lookup. `consumeAppCode` (`apps/api/src/identity/repo.ts`) is one `UPDATE … RETURNING`. It spends the code only when all of these hold: its hash matches, `code_challenge` is the SHA-256 of the verifier, the code belongs to an account, it is unused, and it is inside its minute. An unknown, used, expired or staff code and a wrong verifier all get the same 401 `auth_code_used`, and a wrong verifier leaves the code unspent. If two exchanges arrive at once, the second waits on the row's lock and then finds the code spent. The challenge is computed with `hashOneTimeCode`, the same SHA-256 hex the code's own hash uses.

4. **The panel is not bound.** The staff start stores no challenge, and the staff exchange (`exchangeAdminCode`) stays as it was. The panel runs in a browser, and its code comes back to the panel's own https origin in the URL fragment, inside the same tab (`admin-session.ts`, ADR-025). On a desktop browser and on Android 12 and later, no other app is offered that return; on Android 11 and older, an app that declares the panel's host can be offered it in the chooser, as with the start URL (What it does not close). Accepted for now: few staff, a staff session is eight hours and refused the moment a role is taken away, and a staff identity is a bank-verified person who can be banned; binding the panel's code too is the change if that ever matters. A staff row has a NULL challenge and no account, so the app's exchange can never spend it.

5. **The random source is a shortcut.** No CSPRNG reaches JavaScript in the app without a native module, and a native module moves the Expo fingerprint. So the verifier is two native version-4 UUIDs (`globalThis.expo.uuidv4()` from expo-modules-core), with the dashes removed: 244 random bits. They come from SecureRandom on Android and from Foundation's `UUID()` on iOS. The SHA-256 is `@noble/hashes`, pinned exactly. The ceiling is that RFC 9562 §8 says not to rely on a UUID being hard to guess, nor to use one as a security capability (§6.9 expects a CSPRNG behind a version-4 UUID): Android's source is documented as cryptographically strong, and iOS's is arc4random in practice but not by contract. `expo-crypto`'s `getRandomBytes(32)` in the native batch (#184) lifts it, with its digest in place of `@noble/hashes`. The formats stay the same, so the API does not change. The code carries a `shortcut:` comment that says so.

6. **This is not Telia's PKCE.** Nothing new is sent to the broker. Its request object carries no `code_challenge`, and the API stays a confidential client with `private_key_jwt`. ADR-016's open item on PKCE is about Telia's code alone and stays open.

## Consequences

- An app bundle from before this change gets a 400 page in the system browser at the start, until its EAS Update applies. With `checkAutomatically: ON_LOAD` and `fallbackToCacheTimeout: 0`, the update applies at the launch after it downloads. §5 leaves the fingerprint where it was, so the fix reaches the installed builds over the air, with no new build.
- Attempts in flight at the deploy, ten minutes of them at most, have no challenge, so their codes are never exchanged and their people start again. There are no real users yet.
- A code from an older browser tab is refused (§1). The end-to-end flows' retry taps again only while the sign-in button is still on screen, that is, before any browser has opened.
- The pending mark's guard against a code from somebody else's login is now also enforced by the server. Before, such a code got through while this phone had a login of its own pending; now it fails at the exchange, since it was not started with this phone's verifier.
- The verifier travels only in a POST body and the challenge in the start URL's query, and the request log line carries neither. The PII-in-logs test sends both through the start and the exchange.
- The demo's client (`apps/api/scripts/demo/bank.ts`) makes a pair with `node:crypto` for every login, so `demo:reset`'s local histories and the mock-bank tests keep signing the personas in through the real routes. Staging's demo commands call the services directly and send no HTTP request, so they need nothing.
- One nullable column. The exchange still finds its row through the code hash's unique index.

### What it does not close

- **An attempt that another app starts.** An app that claims the scheme can open `/auth/start` itself with a challenge of its own, so it holds that attempt's verifier. The bank page it leads to really is Kuutti's login, and a person who completes it signs that app in.
- **The start URL on Android 11 and older.** An app that declares the API's https host can be offered in the chooser for the start URL, and can put an attempt of its own in its place in the same way.
- **The panel's return on Android 11 and older.** An app that declares the panel's host can be offered the https return with the staff code in its fragment, which is not bound (§4).
- The verified links of #184 make both harder, since a return on a verified link reaches only Kuutti's app.

## Alternatives considered

- **`expo-crypto` now:** a CSPRNG by contract, but it moves the fingerprint of both platforms. That means a native preview, four EAS builds, and every installed build and the shared simulators' dev clients orphaned, one native batch ahead of #184. §5 takes it at #184 instead.
- **An optional challenge for a transition:** it keeps the hole open for every attempt that has no challenge, and leaves a NULL branch to remove later, when the installed builds receive the fix over the air within a launch.
- **base64url, as RFC 7636 writes S256 (43 characters):** it would reuse the code's pattern, but it needs base64url helpers on both sides. Hex reuses `hashOneTimeCode`, and `expo-crypto`'s digest is hex by default, so the swap of §5 keeps the format. The RFC binds an OAuth server, not our own code.
- **A wrong verifier spends the code:** this would give whoever sees the code, without its verifier, a way to burn the person's sign-in. It adds nothing against guessing, which 244 bits within 60 seconds, behind the address's limit, already rules out. It would also break today's rule that an expired code is refused unspent.
- **A verifier registered by a POST before the browser opens:** a second round trip and a new way of opening the browser, to protect a challenge that is not secret.
- **Keeping the verifier for the pending mark's ten minutes, so an older tab's code still works:** one verifier would then serve two attempts.
- **Binding the panel too:** nothing can intercept its return (§4).
- **A log line that tells a wrong verifier from an unknown code:** one more query on every refused exchange, and noisy, since a code from an older tab (§1) would be logged as one.

## History

- 2026-10-28, ADR-058 (#472): a session's ninety days count from its last refresh, up to a year from the bank login, so the app of Context that took the code holds the person's tokens as long as it refreshes them at least every ninety days, up to that year. No point changes.
- 2026-10-28, ADR-059 (#490): an earlier refresh token of a session presented again ends the session for every holder, however many refreshes back it is. That does not reach the app of Context, nor one that starts an attempt of its own (What it does not close): the person's own app never held a token of that session, so none comes back, and the line above stands. No point changes.
