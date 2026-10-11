# ADR-017: The Telia Tunnistus client as a workspace package, MIT

- Status: accepted (the maintainer's decision of 2026-10-08, after the first login on Telia's pre-production bed)
- Date: 2026-10-08
- Follows: TD-1 and TD-7 (what the callback keeps; the adapter stays in the identity slice), CLAUDE.md rules 1 and 3, `.claude/rules/layout.md` (what is horizontal lives in `packages/*`), `docs/vendors/telia.md` (the conformance table is the package's test suite), ADR-016 (a product policy the package does not carry); issues #44, #32, #33

## Context

Telia publishes an integration guide and a Python sample and no library in any language (#44). The dialect has traps that show only against the real service or a faithful double: the JWE names the client's `enc` key by the registered kid, `openid-client` skips the ID token signature by default, an unencrypted token must be refused, `auth_time` must be present for any freshness rule to mean anything. This repository solved them in the identity slice and proved them against the pre-production bed on 2026-10-08.

Two things argued for taking that code out now: the protocol surface is stable (a complete login has run; the open questions of the onboarding are answered; the second broker, Idura, is off the table, so the shape is "Telia Tunnistus client", not "FTN broker abstraction"), and the next Finnish relying party would otherwise solve the same traps again. One thing argued against a second repository: every lesson the bed still teaches would become a release, a bump and a lockfile pull request elsewhere, with nobody outside to justify it.

## Decision

1. **`packages/tunnistus-oidc`, a workspace package of this monorepo**, consumed by the API and by the db seed as `workspace:*`. One repository, one pull request per change, no version to jump between. Publishing to npm is a release decision of its own, later, from the monorepo: a build step (the package ships TypeScript sources today, as every package here does), provenance, a changelog, and `private: false`. If the package ever needs its own home, `git subtree split` carries its history out.
2. **MIT**, with its own `LICENSE` and `README.md` in the package directory, inside the AGPL-3.0 repository; the root README says so. The association holds the copyright. The licence policy already allows MIT, so the check stays as it is.
3. **What is in it, and the shape of its API.** One entry point, `createTunnistusClient(options)`, returning `startLogin` and `completeLogin`; options, never environment variables; a `telia` dialect and a `plain` one for a mock, chosen explicitly or by the issuer's host; `TunnistusError` with a `reason` and no personal data; discovery with the issuer checked; `keyIdOf` and `publicJwk` for registration; the hetu format under `./hetu` (parse, every century sign, the check character, the reason a code is refused, the age rule, a generator; never legal sex); the broker's double under `./testing`, with `hono` as an optional peer dependency. The client returns every FTN claim Telia sent, typed, with `null` for what is absent, and logs nothing: what to keep and what to log is the consumer's.
4. **What stays in the identity slice.** `oidc-broker.ts` is the adapter: `prompt=login` on every request (ADR-016), the answer reduced to the code and the event's references (rules 1 and 3: names and the date of birth go with the frame), the kit's errors as `BrokerError`, the boot error that names the SSM parameters. The HMAC, the rules, the one-time code, the routes and the freshness check are the product's and do not move.
5. **The conformance table in `docs/vendors/telia.md` is the package's test suite**: every requirement of the guide is produced by the client and checked by the double, or produced wrongly by the double and refused by the client, in `client.telia.test.ts`; the plain dialect runs against the real mock IdP in the compose job; the adapter's own test checks only what Kuutti adds.

## Consequences

- The API's `package.json` no longer names `openid-client` or `jose`; the kit does. The Docker build copies the package like the other three.
- `@kuutti/db` depends on the kit for the hetu generator of its seed and personas; the kit depends on nothing of ours.
- A change to the dialect is a change to the package and its conformance test; a change to what Kuutti keeps of a person is a change to the adapter. Neither needs the other's review.
- Before the first npm release: a build (`exports` to compiled files), `files` checked, a changelog, the publish workflow with provenance, a decision on the name (`@kuutti/tunnistus-oidc` is the workspace name).

## Not decided here

- The npm release itself, and whether the package also carries a key-generation command (today `infra/scripts/telia-keys.sh` does that for Kuutti).
