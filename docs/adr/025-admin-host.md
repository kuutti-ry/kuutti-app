# ADR-025: The moderation panel's host

- Status: accepted (the open points at the end are the maintainer's)
- Date: 2026-10-16
- Follows: TD-2 (free tiers), ADR-004 §3 (the trust of the `preview` environment: write access), ADR-005 (the media distribution, signed photo URLs on the API's name), ADR-006 §7 (the panel had no host yet), ADR-012 (the preview sweep, which never waits for a person), ADR-014 §1 (no bank on a preview API), ADR-018 (staging is the demo, its data invented), rules/admin.md ("a static SPA built to S3 behind CloudFront on `admin.<domain>`; PR previews are a bucket prefix"), rules/infra.md; issues #313, #302, #106

## Context

The panel (#106) is a static single-page app: Vite builds `apps/admin` into a few files, and everything a moderator does goes to the API with a staff token from the bank login (ADR-006 §5). Until now it ran on a developer's laptop, and staging's `admin-app-url` pointed at `http://localhost:5173`, so a volunteer could not open it. rules/admin.md settled the shape early: a private bucket behind CloudFront on `admin.<domain>`, and a pull request's preview as a prefix of the same bucket.

Four things are not settled by that line. Since #302 the panel has a page per path (`/photos`, `/accounts/:id`), and an S3 origin behind origin access control answers a path it has no object for with 403, not with the app. The repository had no response-headers policy, no CloudFront Function and no access log on any distribution or bucket, so the panel's headers are the first. A preview under `pr-<n>/` cannot reach a bank: preview APIs have none (ADR-014 §1), and staff sessions live in staging's database. And a preview must be written and removed by a job that holds no PowerUser role, since preview builds run a pull request's code (ADR-004).

## Decision

1. **A distribution of its own, at `admin.staging.kuutti.app`.** Not a path on the API's distribution: the API serves `/admin/*` routes of its own there, and the panel's CSP would then cover the API's responses too. `infra/modules/admin` follows `modules/media`: a private bucket (`kuutti-admin-<env>-<account>`, public access blocked, `BucketOwnerEnforced`, SSE-S3, no versioning, since every object is the build of a commit and CI rebuilds it), origin access control signing every request, an ACM certificate in us-east-1 validated by DNS, and A and AAAA alias records in the environment's zone. `PriceClass_100`, HTTP/2 and 3, TLS 1.2 (2021) and up. Production comes with #25 (`admin.kuutti.app`), from the same module.

2. **A path is the app.** The bucket answers 403 for a key it does not have, because CloudFront may not list it; a custom error response turns 403 and 404 into `/index.html` with 200, so `/accounts/<id>` loads the panel and the router finds the page (#302). No route segment of the panel holds a dot, so a missing asset (`/assets/x.js`) is the only path that also gets the app, and it fails as JavaScript, not silently.

3. **The headers.** A response-headers policy on every behaviour, the house set of the website (`kuutti-app-site`) plus what a script needs:
   - `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' <api>; connect-src <api>; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, where `<api>` is the API's origin: the only place the panel talks to, and the name the signed photo URLs are on (ADR-005). No third party, no inline script or style; the panel's forms all prevent their default, so `form-action 'none'` holds. No worker of any kind: `worker-src` would otherwise fall back to `script-src 'self'`, and a service worker registered from a preview's prefix could take the whole origin, the root's panel and the bank's return to it included, and outlive the preview.
   - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
   - `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, and `X-Robots-Tag: noindex, nofollow` as the API sends.
   - zod probes for `new Function` once, when the first object schema is built, and a strict CSP reports the probe even though zod catches it; the panel sets `z.config({ jitless: true })` in a module imported before any schema is built (`src/jitless.ts`, first in `main.tsx`), so nothing is reported (zod becomes a direct dependency of `apps/admin`, the version `packages/schema` has). Vite inlines an asset under 4 KB as a `data:` URL, which `img-src` refuses, so the build inlines nothing (`assetsInlineLimit: 0`).

4. **Caching.** The managed `CachingOptimized` policy. CI uploads `index.html` with `Cache-Control: no-cache` and the hashed assets with `public, max-age=31536000, immutable`, then invalidates `/*` (the first thousand paths a month are free, and `/*` counts as one). Source maps go up with the build: the source is public under the AGPL.

5. **The deploy from `main`.** `build.yml` gains two jobs after `deploy-staging`. The first builds the panel with `VITE_API_URL` set to the staging API, holding no credentials (its `pnpm install` runs dependencies' scripts); the second downloads the build and holds the `staging` environment's role (`kuutti-ci-apply`, PowerUser), syncs it to the bucket's root (`--delete`, but never under `pr-`), invalidates, and checks the served page and its headers, and the API's CORS for the panel's origin. Both stop green while the environment's variables are not set, so the jobs wait for the first apply as the other lanes do.

6. **Previews under `pr-<n>/`, against the staging API.** `preview.yml` gains a lane that builds the panel with Vite's base `/pr-<n>/` and `VITE_API_URL` set to the staging API, and a job without an environment that writes it to `pr-<n>/` with the plan role. The router takes `BASE_URL` as its basename, trimmed of the slash, since react-router does not match `/pr-12` against `/pr-12/`. A viewer-request CloudFront Function (`cloudfront-js-2.0`) on the `pr-*` behaviour alone rewrites a path inside a preview whose last segment has no dot to that preview's `index.html`; the root keeps the fallback of point 2, which would otherwise serve main's `index.html` for every preview path. It is the repository's first CloudFront Function; Lambda@Edge stays out (rules/infra.md).

   The staging API, because a preview API cannot sign anyone in and a staff token is a staging one. Its consequence: a pull request that changes the API and the panel together previews its panel against `main`'s API. The bank returns the one-time code to staging's `admin-app-url`, the root, so a member of staff signs in at the root and opens `/pr-<n>/` in the same tab, where the session is (sessionStorage is per tab and per origin). Preview code runs on the staging panel's origin, so a preview can read a staging staff session in the tab it is opened in; the trust is write access to the repository (ADR-004 §3), and staging holds invented people only (ADR-018).

7. **The plan role writes `pr-*` and nothing else.** One inline policy on `kuutti-ci-plan` (`admin-previews`, `infra/bootstrap`): `s3:PutObject` and `s3:DeleteObject` on `kuutti-admin-staging-<account>/pr-*`. Listing comes with its ReadOnlyAccess; reading objects stays denied. No new role and no new trust: the plan role already trusts pull requests and `main` (ADR-012 §3), and `preview` gets no PowerUser role. The most a pull request can do with it is replace or remove another pull request's panel preview, which it could already do through its own.

8. **The sweep removes the prefix.** `preview-cleanup.yml` gains a job that removes `pr-<n>/` for every pull request the sweep selects, with the plan role, from `main`. A failure there never blocks the removal of the Dokploy application (ADR-012 §4): the job fails naming the command to run by hand, and a lifecycle rule expires every `pr-` object after 14 days as the backstop, the sweep's seven days with room.

9. **No access log.** The host serves the same public files to everyone; who asked for what is in the API's log, whose request line carries the staff member's identity (`staffIdentityId`, ADR-026 §7) and the request id for every call that passes a staff guard. A log of the host would add staff members' IP addresses and nothing a moderator does. rules/infra.md keeps access logging to the research prefix.

10. **The parameters.** Staging's `admin-app-url` becomes `https://admin.staging.kuutti.app`, and `cors-allowed-origins` that origin alone: once the bank returns the code to the hosted panel, a panel on a laptop cannot finish a staging login anyway. A developer's panel against their local API is unchanged (`pnpm env:up`).

## Consequences

- Cost: about nothing. CloudFront's free tier (1 TB out, 10 million requests and 2 million function invocations a month), a free certificate, free alias queries, and a few megabytes in S3.
- The order of the first apply, the maintainer's: the bootstrap (the plan role's policy), then the environment (by the merge, as `infra.yml` applies staging from `main`), then the GitHub variables from `tofu output`, then a re-run of `build.yml`'s panel jobs. The API reads its parameters at boot, so it is restarted once if it booted before the new `admin-app-url` (a deploy does that). Between the apply and the first build, staff logins on staging land on an empty host.
- A preview that is not there, or not yet, shows `main`'s panel and its "not found" page, since the fallback of point 2 covers the whole distribution.
- A preview shares the origin's storage and cookies with the root's panel, and they outlive it: local storage, IndexedDB and the Cache API, and cookies a preview could set for `kuutti.app` and its subdomains. Nothing reads them: the panel keeps its state in session storage and the API, and nothing on `kuutti.app` trusts a cookie. That stays a rule: anything that ever does names its cookie `__Host-` and keeps the panel's state out of the origin's lasting storage.
- Merging a change of `modules/admin` changes staging's panel host at once, as any other module.

## Alternatives considered

- **A path on the API's distribution:** the CSP and the panel's caching would cover the API's own answers, and `/admin/*` is taken (point 1).
- **A subdomain per preview (`pr-<n>.admin…`):** needs a wildcard certificate, which the zone does not use (`infra/bootstrap/dns.tf`: "wildcards are not used"), a DNS write per preview, and an origin per preview for the API's CORS list.
- **Previews against their own API:** they can show the sign-in screen and nothing after it (point 6), and they would need a second headers policy and a CORS change on every preview API.
- **A role for previews trusting `environment:preview`:** the same trust as the plan role, since `preview` has neither a reviewer nor a branch policy, with one more role, output and repository variable to keep.
- **CloudFront standard logs to a new bucket:** possible without ACLs (log delivery v2), and cents a month; not taken for the reason of point 9.

## Open, the maintainer's

- A preview's login lands at the root: a small change to the panel's return path could send the person back into `/pr-<n>/` after the bank. It touches the delivery of the one-time code, so it waits for its own change and the security review.
- Whether `http://localhost:5173` stays in staging's CORS list for a developer pointing a local panel at staging's API without signing in.
