# ADR-066: The box knows Kuutti's distribution by a secret header

- Status: proposed (#198, the maintainer's choice of 2026-11-06 among the three options of ADR-008's History of that day: the secret header; built as written here; the bootstrap's apply, the secret written by hand and the switch of §6 put it to work; accepting it is the maintainer's)
- Date: 2026-11-06
- Follows: TD-2 (CloudFront fronts the API), TD-19 (the parameter store and the instance role), ADR-008 §5 (whose word the API takes for the client address), ADR-005 §7 (CloudFront-only ingress), ADR-001 (a secret value never enters OpenTofu's state), ADR-004 §3 (write access is staging-level trust); issues #198, #25

## Context

Since #623 staging's box admits 443 from CloudFront's origin-facing prefix list alone. That list holds every CloudFront distribution's servers, not Kuutti's alone, and any distribution may add a custom origin header named `CloudFront-Viewer-Address` with a value of its own: AWS's list of headers CloudFront refuses to add names no `CloudFront-*` header. So ADR-008 §5's `cloudfront` mode, which keys the rate limiter on that header, would key it on a value anybody picks (ADR-008, History of 2026-11-06). In `traefik` mode the limiter keys on the CloudFront server that forwarded a request: nobody can forge that, but everybody behind one server shares its bucket, and one sender can fill the sign-in doors for all of them. ADR-008 §5 keeps that out of production, so production's photo cutover waits for a proof that a request came through Kuutti's own distribution.

AWS's documented way to restrict an origin to one's own distribution is a custom header with a secret value, checked at the origin. Its strength is the secret's. Two places AWS offers for the value would put it where it does not belong. As a custom origin header in the distribution's configuration it would sit in OpenTofu's state (against ADR-001), and CI's plan role, whose ReadOnlyAccess grants `cloudfront:Get*` and which any pull request may assume, could read it with `GetDistributionConfig`. The same role reads a CloudFront key value store's values, since ReadOnlyAccess also grants `cloudfront-keyvaluestore:Get*` and `List*`.

## Decision

1. **A header, `x-kuutti-origin`, on every request of the distribution's default behaviour** (the API, Dokploy, the previews). A viewer-request CloudFront Function (`cloudfront-js-2.0`, `infra/modules/media/origin-proof.js`) removes any value the viewer sent and sets the store's. The `/media/*` and ACME behaviours carry no function: neither the bucket nor Traefik's challenge handler asks for the proof. The header's name is public; its value is the secret. The function is tested under `node:vm`, as CloudFront runs it (`apps/api/src/lib/origin-proof.function.test.ts`), the way the panel's is (`apps/admin/src/preview-paths.test.ts`): a viewer's own value never passes, whether the store answers or not.
2. **The value lives in two places, both written by hand and neither a resource.** It is the one key, `origin-secret`, of a CloudFront key value store, `kuutti-<env>-origin-proof`, written with `aws cloudfront-keyvaluestore put-key`. It is also the SecureString `/kuutti/<env>/origin-secret`, which the API reads at boot through the instance role. OpenTofu declares the store and the function and never a key, so the value is in no state. The function's code names the store's id, never the value. The store is the environment's (`envs/<env>/main.tf`), outside `modules/media`, so production's exists, and can be filled, before its cutover.
3. **The plan role may not read the store's values**: `cloudfront-keyvaluestore:GetKey` and `ListKeys` join `ci_plan_deny_data` in the bootstrap. A plan needs the store's metadata alone, which is the `cloudfront:` control plane. The apply role keeps PowerUserAccess; it runs from `main` alone.
4. **The API trusts CloudFront's viewer address only from a request carrying the proof.**
   - `ORIGIN_SECRET` holds one value of at least 32 characters, or two separated by a space while one replaces the other.
   - Each value is compared by its SHA-256 digest in constant time, every value every time (`lib/origin-proof.ts`).
   - In `cloudfront` mode a request without a valid proof has no address and shares the one bucket of no address (ADR-008 §5), so a flood through anybody else's distribution fills that bucket for the unproven alone.
   - `cloudfront` without a secret is refused at boot, since every request would then share that bucket.
   - In the other modes the secret is optional and changes nothing the limiter does.
5. **`/health` says what the box sees**: `trustedProxy`, the mode read at boot, and `originProof`, which is `valid`, `missing`, `wrong` or `unset` for the request it answers. Both are optional fields of `HealthResponse`, so apps and panels built before them read the answer as before. They let anybody check, before the switch of §6 and after it, that the store and SSM agree. `/health` never echoes the value, and no log line carries it, which the PII sweep (`pii-in-logs.test.ts`) shows by planting it.
6. **The order, on staging and then at production's cutover:**
   1. Merge. The store and the function exist, the store is empty, and the function sends no header. The API still keys on Traefik's hop, and `/health` says `unset`.
   2. The maintainer applies the bootstrap, before any value is written, so the plan role never sees it.
   3. The maintainer makes the value offline, writes it to the store and to SSM, and redeploys. `/health` through the distribution says `valid`.
   4. A pull request sets `trusted_proxy = "cloudfront"`. After its deploy, `/health` says `cloudfront`.
   5. Production fills its store and SSM before its cutover, compares the two by digest (its function does not exist yet), and redeploys once so the running API holds the value. The cutover commit then sets `media_enabled`, `cloudfront_only_ingress` and `trusted_proxy` together (ADR-008 §5). The maintainer approves the tag's infra apply first, sees `traefik` and `valid` on `https://api.kuutti.app/health` from the API that has not restarted, and only then approves the deploy (`infra/README.md`, Media).
7. **Rotation** (`docs/runbooks/rotation.md`): SSM takes the old and the new value, and the API is redeployed. The store takes the new value. SSM keeps the new value alone, and the API is redeployed again. A leak is what a rotation answers.

## Consequences

- Somebody else's distribution can still reach the box. Its requests are counted together in the bucket of no address, never by an address they claim.
- The value travels with every request of the default behaviour, so the API, Dokploy and every preview receive it, and the apply role (PowerUserAccess, from `main` alone) can read both copies. Anybody holding the value can forge a viewer address through a distribution of their own until it is rotated. On staging the previews can read it: preview code holds the instance role, which reads `/kuutti/staging/*`, ADR-004 §3's trust. Production has no previews.
- The function runs on every request of the default behaviour, at CloudFront's price per invocation, which at Kuutti's size is cents a month. A store read is inside the function's time limit.
- `.claude/rules/infra.md`'s "the repository's one CloudFront Function" becomes two: the panel's and this one.
- A store whose key is missing does not stop a request. Nor does an empty store that the API does not yet rely on: the function sends no header and the request goes on. In `cloudfront` mode such a request has no address. So §6's order puts `valid` on `/health` before the switch.

## Left out on purpose

- **CloudFront's VPC origins.** AWS's service-managed security group admits one's own distributions alone, and no secret is kept. But the box would move to a private subnet without a public address, and its outbound calls (Telia, Expo, GitHub's registry, Let's Encrypt, AWS's APIs) would need a NAT gateway, a new monthly cost for each environment, or a NAT instance to maintain. Worth it if the box should leave the internet altogether, which would also settle the security checklist's TLS line.
- **A custom origin header in the distribution's configuration.** It is simpler, but its value would be in state, and readable by the plan role (Context).
- **Staying on `traefik`.** It needs nothing built, and keeps the shared bucket that ADR-008 §5 keeps out of production.
- **A random header name**, which AWS suggests beside a random value: the name is in this public repository, and the value carries the secret.
- **The header for the API's hosts alone**, sparing Dokploy the value: Dokploy is the maintainer's control plane, and the previews need it in `cloudfront` mode.

## Checked at the switch, not before

Each rests on AWS's documentation or on Dokploy's defaults, and nothing in the repository can show it:

- CloudFront replaces a viewer's own `CloudFront-Viewer-Address` on Kuutti's distribution. Two requests from one machine with different forged values must spend one bucket (`RateLimit-Remaining` falls across them). If they do not, the switch goes back.
- The function runs on the chat's WebSocket upgrade (`GET /ws`). If it did not, every phone's upgrade would be unproven and share one bucket, which fails closed but would refuse reconnects.
- A key's write is not in CloudTrail's event history (`aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=PutKey` finds nothing). The plan role is denied that history all the same.
- Traefik's access log keeps no request headers (`accessLog.fields.headers.defaultMode` in Dokploy's `traefik.yml` is not `keep`), so the value is not on the box's disk or in its nightly backup.
- The first plan after the bootstrap's apply refreshes the store through the `cloudfront:` control plane alone.
