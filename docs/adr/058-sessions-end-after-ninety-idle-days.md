# ADR-058: A phone's session ends ninety days after its last use, and a year after its bank login

- Status: accepted 2026-10-28 (#472, the maintainer's decisions of that day: a ceiling of a year from the bank login, kept with Open 1, recognising any earlier refresh token, as a change of its own; built as written here)
- Date: 2026-10-28
- Follows: TD-1 (every account is a bank login), ADR-016 §3 (what a sign-in costs; amended here), ADR-027 (the sign-in bound to the device), ADR-045 (the app lock gates the screens, never the session), ADR-055 §3 (a push token goes with its session), ADR-056 (what a lifted refresh token can do), `docs/security-checklist.md` (the sessions item), RFC 9700 §4.14.2, OWASP ASVS 5.0 7.1.1, 7.3.1 and 7.3.2; issues #35, #25, #396, #472

## Context

#35 gave each phone a session of its own: an access token of fifteen minutes and a refresh token, both replaced at each refresh, a retired refresh token presented again ending the session. The session's end was fixed ninety days after the bank login: `issueSession` wrote it, `rotateSession` never moved it, and a test held it there. A phone opened every day therefore went to the bank every ninety days.

Each bank login is an identification at Telia's broker, billed to the association (#25). With every active phone paying one a quarter:

- 600 members with a phone each cost some 200 logins a month, the whole of the 2025 offer's smallest package (55 € a month for 200 logins);
- the 5,000 that Kuutti is sized for cost some 1,700 a month, before any registration, new phone or sign-out.

ADR-016 §3 counted on long-lived sessions to keep the billed logins few, and named registration, a new device and a revocation as the moments of a sign-in. The fixed end was not among them. ADR-022 calls a bank login free, and ADR-045 a minute of the person's time; neither counts the association's bill.

The standards ask for two limits, each written down with its reasons:

- RFC 9700 §4.14.2: "Refresh tokens SHOULD expire if the client has been inactive for some time".
- OWASP ASVS 5.0 asks for an inactivity timeout (7.3.1) and an absolute maximum session lifetime (7.3.2), both enforcing re-authentication, and for both to be documented with any deviation from NIST SP 800-63B (7.1.1).

The privacy notice on kuutti.app already says, in its How long table, that a session you do not use is kept ninety days.

Three things already limit a refresh token taken from a phone, one of them less than it seems:

- rotation, one refresh back: the row keeps the hash of the token the last refresh retired, and that token presented again ends the session for both holders (`refreshSession`, `apps/api/src/identity/sessions.ts`). A token two refreshes old reads as unknown and ends nothing (`rotateSession`, `repo.ts`). So a taker who refreshes twice before the owner's next use is not caught: the owner's phone is signed out as if its session had ended, and the taker keeps the session;
- Log out everywhere ends every device's session at once, and a sanction does the same (ADR-024);
- the tokens are kept in the phone's secure store, readable while the phone is unlocked and on that device only (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, `apps/mobile/src/lib/session.ts`), so neither a backup nor a new phone carries them.

## Decision

1. **The end moves at each refresh.** A refresh sets the session's end to ninety days from that refresh (`REFRESH_TOKEN_TTL_MS`). It does so in the statement that rotates the tokens (`rotateSession`, `repo.ts`), so of two concurrent refreshes the one that wins is the one that moves it. The bank login counts as the first refresh. The app refreshes at its first request after the access token's fifteen minutes (`apps/mobile/src/lib/api.ts`), so the end trails the phone's last use by fifteen minutes at most. A phone used at least once in ninety days stays signed in. One left alone for ninety days goes to the bank, as before. An idle end is not a revocation: the row waits for the night's sweep, as an expired one always did.
2. **A ceiling of a year from the bank login.** The end never moves past a year (365 days, `SESSION_CEILING_MS`) after the session row's creation. The row is created when the app exchanges the bank login's one-time code, within the code's minute of the login (ADR-027). The ceiling is read from the row's `created_at`: no new column, no migration. At the year, even a phone in daily use goes to the bank again. The maintainer chose a year on 2026-10-28, over no ceiling and six months: it bounds a lifted token and a phone passed on while signed in, and it costs a twelfth of a login a month per active phone, against a third until now.
3. **Nothing else changes.**
   - The access token's fifteen minutes, rotation and its reuse rule.
   - Sign-out, Log out everywhere and the sanctions.
   - The night's sweep, which reads the same column, and the push token, which goes with its session (ADR-055 §3).
   - The phone never reads the end. `refreshExpiresAt` in the refresh's answer now names the moved one, and so does the session's own read (`GET /auth/session`).
   - The admin panel keeps its eight hours with no refresh, a security choice for staff (#49).
   - Every sign-in that asks for the bank today still does (ADR-016).
4. **The deviation from NIST SP 800-63B, as ASVS 7.1.1 asks.**
   - NIST's AAL2 asks for an overall reauthentication timeout of no more than 24 hours and an inactivity timeout of no more than an hour (SP 800-63B-4 §2.2.3, both as SHOULD).
   - Kuutti's session meets neither, and did not before this record either. A bank login is a billed identification and a minute of the person's, and a dating app opened daily would send everybody to the bank daily.
   - What stands in for them: a session bound to one device and rotated with reuse detection one refresh back, the ninety days and the year of points 1 and 2, and the app lock for a phone in somebody else's hand (ADR-045), which is off until the person turns it on.

## Consequences

- At 5,000 active members the year costs some 420 logins a month instead of some 1,700; at 600, some 50 instead of some 200. Registrations, new phones, sign-outs, sanctions and Log out everywhere come on top, as before.
- A refresh token taken from a phone now works as long as somebody refreshes it at least every ninety days, up to the year. The owner's next refresh ends it only while the taker has refreshed once at most since the owner's last. A taker who refreshes twice first signs the owner out instead, and keeps the session until the year, ninety idle days, a sanction or Log out everywhere. Before this record that session ended ninety days after the bank login at the latest. ADR-056's "lifted 90-day refresh token" and ADR-027's app that took the code read so since this record (their History).
- Lifting the token takes the phone's secure store, unlocked, on that device (Context). Recognising every earlier token of a session, rather than the last one alone, would close the gap. That needs the refresh token to carry a secret of its session, a column to find it by, and a contract change, so it is a change of its own (Open 1).
- A session row can live longer: until the night after its end, a year after the bank login at most. One ended earlier, by a sign-out or a revocation, is kept thirty days after that, and never past the night after its end. `docs/runbooks/police-disclosure.md` says so where it says how long a device is kept. The privacy notice needs no change: it keeps a session in use until it is ended, and one not used ninety days.
- ADR-016 §3 names the two moments this record adds (its History).
- `docs/security-checklist.md`'s sessions item, `docs/architecture/sequence-login.md` step 27, `docs/runbooks/capacity.md` (the load smoke's file of tokens), `.claude/rules/api.md` and the contract's description of `refreshExpiresAt` say the same.
- `features/identity/sessions.feature` gains three scenarios: a refresh moves the end, a phone left for ninety days, and the year. Their tests run on a clock of their own, so the boundaries are exact: the end's last millisecond still refreshes, and the year's first one does not.
- `docs/decisions.md`, the register of product decisions (#396), names this record in its sign-in rows: the access token's fifteen minutes, the ninety days after the last use, and the year.

## Alternatives considered

- **No ceiling.** Fewest logins: new phones and sign-outs only. But a lifted token or a phone passed on would last as long as somebody uses it, and ASVS 7.3.2 asks for an absolute lifetime.
- **Six months.** About 830 logins a month at 5,000 members, for a tighter bound on a lifted token.
- **Moving the end at every request** (`touchSession`) rather than at the refresh. The refresh already follows any use within fifteen minutes, and the request's path would write the end on every call.
- **A column for the bank login's time.** The row's `created_at` is that moment already, within the code's minute.

## Open, the maintainer's

1. Recognising any earlier refresh token of a session, so that the owner's next refresh ends a lifted session however often the taker refreshed (Consequences). The maintainer chose on 2026-10-28 to keep the year with this gap written down, and to design the recognition as a change of its own: #490.

## History

- 2026-10-28: written with #472, on the maintainer's answers of that day: a year from the bank login, kept once the review had shown that rotation catches reuse one refresh back only (Open 1).
