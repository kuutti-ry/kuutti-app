# ADR-059: A refresh token carries a secret of its session

- Status: accepted 2026-10-28 (#490, the maintainer's answer of that day on the shape: the issue's two 256-bit parts, over two 128-bit parts in today's 43 characters; every installed app is his, and the new rules overtake the old; built as written here)
- Date: 2026-10-28
- Follows: TD-1 (every account is a bank login), ADR-003 (the contract and `pnpm openapi`), ADR-018 (staging's people are Telia's test persons), ADR-024 (a sanction ends every session), ADR-027 (the sign-in bound to the device), ADR-055 §3 (a push token goes with its session), ADR-056 (what a lifted refresh token can do; attestation later), ADR-058 (the ninety days and the year; its Open 1 is settled here), CLAUDE.md rule 10 (a custom migration's SQL in an ADR), `.claude/rules/api.md` (session tokens), `docs/security-checklist.md` (the sessions item), RFC 9700 §4.14.2; issues #35, #472, #490

## Context

#35 gave each phone a session: an access token of fifteen minutes and a refresh token, both 256 random bits, kept as SHA-256 hashes and replaced at each refresh. Besides the live refresh hash the row kept one more, `retired_refresh_hash`: the token the last refresh retired (`rotateSession`, `apps/api/src/identity/repo.ts`). That token presented again ended the session as `refresh_reuse` (`refreshSession`, `sessions.ts`, through `findSessionByRetiredRefreshHash`). A token two refreshes old matched neither column. It read as unknown, the answer was 401 `session_revoked` with the reason `unknown_or_expired`, and nothing was revoked.

So rotation caught a taker one refresh back only. A taker lifts R1 from a phone and refreshes twice while the phone sleeps: R1 to R2, then R2 to R3. The owner's phone then presents R1, which the row no longer knows. The phone is signed out as if its session had ended, and the owner signs in through the bank into a new session. The taker's session goes on with R3.

Until ADR-058 the taker's session ended ninety days after the bank login at the latest. Since ADR-058 a session in use lasts up to a year from its bank login, so the missed case lasts up to a year. The maintainer kept the year with the gap written down (ADR-058 Open 1) and asked for the recognition as a change of its own.

What already limits it:

- lifting a token takes the phone's secure store, unlocked, on that device (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, `apps/mobile/src/lib/session.ts`);
- Log out everywhere ends every device's session, and a sanction does the same (ADR-024);
- ninety idle days and the year end the session (ADR-058).

RFC 9700 §4.14.2 describes rotation: the previous refresh token is invalidated, "but information about the relationship is retained by the authorization server". Whichever party then presents an invalidated token tells the server of the breach, and the server revokes the active one. That works only if the server knows every invalidated token of the grant, not only the last. The same section allows the grant to be named in the token itself, if the server protects that name from forgery, for example by a signature.

## Decision

1. **The shape.** The refresh token is two parts joined by a dot, `<family>.<rotating>`. Each is 32 random bytes as base64url (43 characters), 87 characters in all. The family part is drawn once, at the exchange (`issueSession`, `apps/api/src/identity/sessions.ts`), and kept for the session's life. The rotating part is drawn again at every refresh. The access token is unchanged: 32 random bytes, 43 characters.
2. **At rest.** The row keeps `family_hash`, the SHA-256 of the family part (new, `NOT NULL`, unique), and `refresh_hash`, the SHA-256 of the whole token, as before. No plaintext part is stored. `retired_refresh_hash` and its index `session_retired_refresh_hash_idx` are dropped, and `findSessionByRetiredRefreshHash` with them.
3. **Rotation** stays one `UPDATE` keyed by the live `refresh_hash` (`rotateSession`), so of two concurrent refreshes exactly one wins, as since #35. It still moves the session's end (ADR-058 §1). The next token keeps the family part and has a new rotating one.
4. **Recognition.** When the rotation finds nothing, the API looks the presented token's family part up by `family_hash` (`findSessionByFamilyHash`, `repo.ts`). There are three outcomes:
   - A session is found whose live refresh hash is not the presented token's. The token is an earlier one of the session, or one made up around its genuine family part. The session is revoked as `refresh_reuse`, for every holder, and the answer is 401 `session_revoked` with the reason `reuse`. A session already revoked keeps its revocation and its reason, and the answer is the same.
   - A session is found whose live token is the presented one. The session is over by itself: ninety idle days, the year, a sign-out or a sanction. The answer is 401 `session_revoked` with the reason `unknown_or_expired`, and nothing is revoked, since an idle phone is no theft.
   - Nothing is found. The answer is 401 `session_revoked` with the reason `unknown_or_expired`.

   So the owner's next refresh ends a lifted session however often the taker refreshed. The taker's access token stops at once too, since every request reads `revoked_at`. The phone's refresh stays single-flight, so its own two refreshes do not race; two that do race still end the session, as since #35.
5. **A secret, not the session's id.** With the session's id in the token, anybody who knew an id could sign that phone out by presenting a made-up token around it. Only a holder of a genuine token of the session knows its family part. RFC 9700 §4.14.2 asks that a grant named in the token be protected from forgery; here a 256-bit secret, kept only as its hash, does that without a signing key.
6. **The contract.** `packages/schema/src/identity.ts` gives the refresh token a pattern of its own, `RefreshToken`, `^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$`, for `AuthRefreshRequest.refreshToken` and `SessionTokens.refreshToken`. The access token keeps `SessionToken`. `pnpm openapi` follows (ADR-003). A token of the old shape, 43 characters, is refused at `/auth/refresh` with 400 `validation_failed`. No transition path accepts it.
7. **The deploy.** Two migrations, in this order (0086 and 0087 as things stand):
   - 0086, `generate --custom` (CLAUDE.md rule 10), ends every session. A row from before has no family part to hash, and its refresh token has the old shape, which the contract refuses. Each push token goes with its session, by migration 0081's cascade (ADR-055 §3). The migrator applies every pending migration in one transaction, so the lock holds through 0087: the container still running the old code during the deploy cannot write a session without a family between the two, which would fail 0087 and the new container's start. Its SQL:

     ```sql
     LOCK TABLE session IN ACCESS EXCLUSIVE MODE;
     DELETE FROM session;
     ```

   - 0087, generated: `family_hash` with its unique constraint `session_family_hash_unique`, and `retired_refresh_hash` and `session_retired_refresh_hash_idx` dropped.

   So every signed-in phone signs in through the bank once after the deploy. The phone checks tokens against the shared contract: `SessionTokens.parse` at load and at refresh (`apps/mobile/src/lib/session.ts`), `AuthExchangeResponse.parse` at sign-in (`apps/mobile/src/features/identity/session.tsx`). A phone on the new bundle reads a stored session of the old shape as no session, and asks for the bank. A phone still on an older bundle is not sent to the bank: its refresh gets the 400 of §6, which it reads as the API being unwell, so it keeps its session and every call fails until it starts on the update (the EAS Update of the same merge), and a sign-in from it would fail too, since it cannot read the new tokens. The maintainer accepted that on 2026-10-28: every installed app so far is his, and the new rules overtake the old. Kuutti has no real users yet, and staging's people are Telia's test persons (ADR-018).

## Consequences

- What it buys: the owner's next refresh ends a lifted session however often the taker refreshed. The window is the time to the owner's next use, or to Log out everywhere, not the year.
- It reaches only a session with two holders. The app that took the code (ADR-027) holds a session the person's own app never had a token of. An owner who reads their own tokens through a proxy (ADR-056, How a token is read) and uses them from a script, with the app left unused, has nobody to give them away. Both keep their session as before.
- What it costs:
  - one bank sign-in for every signed-in phone at the deploy;
  - a phone on an older bundle shows its signed-in screens with every call failing until it starts on its update (§7);
  - the row holds `family_hash` where it held `retired_refresh_hash`, with a unique index in place of a plain one: the same number of hashes once a session has refreshed, one more before.
- The deploy deletes every session row, live and ended. `docs/runbooks/police-disclosure.md` keeps an ended device thirty days and a live one until its end, up to a year after its sign-in (ADR-058); from the deploy on, no answer can name a device as it was before it.
- `features/identity/sessions.feature` gains the scenario "A refresh token two refreshes old ends the session for both holders". `packages/db/src/migrate.test.ts` runs 0086 and 0087 over rows of before.
- `docs/security-checklist.md`'s sessions item, `docs/decisions.md`'s sign-in rows, `.claude/rules/api.md` (session tokens), `docs/architecture/sequence-login.md` and `trust.md`, `docs/runbooks/capacity.md` and `rotation.md` say the same.
- ADR-058 Open 1 is settled, and its Context, §4 and Consequences say "until ADR-059" where they described the gap as present. ADR-056 and ADR-027 say what this changes for them (their History).

## Alternatives considered

- **Keeping every retired hash.** No new shape and no contract change. But the table grows with every refresh of every phone, some ninety rows a day for a phone in use.
- **Binding the token to the device's own key** (DPoP, or attestation in ADR-056 §2's shape). A lifted token alone would be useless. It needs a native module and is a larger change; ADR-056 §1 names when attestation comes back.
- **A transition path** that accepts tokens of the old shape until none is live. Nobody signs in again at the deploy, but the branch lives up to a year (ADR-058 §2), and an old token keeps the one-refresh-back rule for as long.
- **The session's id in the token** in place of a secret: anybody who knew an id could end that session (§5).
- **Two 128-bit parts in today's 43-character shape**, offered on 2026-10-28. It would have kept installed apps working. The maintainer chose the issue's two 256-bit parts.

## History

- 2026-10-28: written with #490, on the maintainer's answer of that day on the shape (the last of the Alternatives). It settles ADR-058 Open 1.
