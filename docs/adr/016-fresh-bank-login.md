# ADR-016: The bank, every time: `prompt=login` and an `auth_time` no older than the attempt

- Status: proposed (built as written here; the maintainer's planning handoff of 2026-10-07 names `prompt=login` as a Kuutti requirement, and this record is the ADR that CLAUDE.md asks for when the identity flow changes)
- Date: 2026-10-07
- Follows: TD-1 (one identity per person, verified at the bank), TD-7 (standing and re-registration decided at the callback), CLAUDE.md rules 1 and 6, `docs/vendors/telia.md` (guide 2.4.3: `prompt`, `max_age`; 2.6.4: `auth_time`), `.claude/rules/api.md` Identity and auth; issues #32, #33

## Context

The bank login runs in the system browser (`.claude/rules/mobile.md` Auth): the API sends the browser to the broker, the broker to the bank, and the bank's answer comes back through the broker to `/auth/callback`. The broker keeps a web single sign-on session in that browser (guide section 2: "web single sign-on use case"). Without a word from us, a second request within that session may be answered from it, with the first person's claims and an `auth_time` from the first authentication, and no bank in between.

Kuutti is a dating app. A phone changes hands: a friend tries the app, a sibling, somebody at a party. A shared or borrowed device must never let the second person in as the first, and never register the second person's account under the first person's identity. Every account is a bank-verified adult because every login went through the bank, not because the browser remembered one.

The guide offers two levers (2.4.3): `prompt=login`, "user is always shown a login page, despite having an existing authentication or not", and `max_age=0`, "force-authn". The ID token carries `auth_time`, "timestamp of user authentication" (2.6.4), and our `auth_request` row carries `created_at`, written by the database when `/auth/start` ran.

Until now the request object carried neither lever, and the confirmations table in `docs/vendors/telia.md` held the question open.

## Decision

1. **Every request object carries `prompt=login`.** The adapter adds it in `startLogin` for both dialects (Telia and the mock IdP), so that the local flow is the deployed flow. `max_age` is not sent: `prompt=login` is the guide's named mechanism for exactly this, and one lever is one thing to verify at the first pre-production login.
2. **An `auth_time` earlier than the attempt is refused.** At the callback, after the broker's answer is verified and before anything is derived or written, the login compares the broker's `auth_time` with the attempt's own `created_at`. An authentication more than two minutes older than the attempt (`AUTH_TIME_TOLERANCE_MS`, `login.ts`) is answered `auth_provider_error`, like any other answer that is not a login of this person; nothing is created or counted. The tolerance is for clocks: the broker's and the database's are both disciplined by NTP and differ by seconds, and a reused session is minutes or hours old.
3. **What this costs.** Every sign-in is an identification event at the broker and, in production, a billed one. Sessions are device-bound and long-lived (#35), so a sign-in happens at registration, on a new device, and after a revocation, not at every app open. The number stays small by the session design, not by skipping the bank.

## Consequences

- `docs/vendors/telia.md`: the open question about `prompt=login` becomes this record; what remains to confirm at the first pre-production login is that Telia honours `prompt=login` with a fresh bank authentication and an `auth_time` to match.
- The fake Telia (`src/test/fake-telia.ts`) and the conformance test assert `prompt: "login"` in the request object; the bank-login feature gains the scenario for a stale `auth_time`.
- The mock IdP shows its login page on every request anyway; `prompt=login` changes nothing locally. Its `auth_time` is the token's issue time when it sends none, which is after the attempt began.
- A person who leaves the bank page open for longer than the attempt's ten minutes (`AUTH_REQUEST_TTL_MS`) is refused by the state check as before; this decision adds no new timeout.

## Not decided here

- PKCE (`code_challenge`, S256): the broker advertises it, the guide does not mention it, and with `private_key_jwt` and a confidential client it defends against code injection only. It needs a column for the verifier; it is a change of its own if wanted.
- Whether `max_age` is also sent, should Telia turn out to honour one lever and not the other. The first pre-production login answers that.
