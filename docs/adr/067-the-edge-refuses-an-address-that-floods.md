# ADR-067: The edge refuses an address that floods

- Status: proposed (#41, the maintainer's choices of 2026-11-06: a web ACL on each environment's distribution, 2,000 requests in five minutes, no managed core rule set, an allow list written by hand for the load smoke; built as written here; the bootstrap's apply and the burst test on staging put it to work; accepting it is the maintainer's)
- Date: 2026-11-06
- Follows: TD-3 (one box, limits in process), TD-6 (abuse), TD-2 (CloudFront fronts the API), TD-4 (AWS, and the budget), ADR-026 (the API's windows, whose Consequences leave volume to the edge), ADR-005 §7 (everything the box serves on 443 behind the distribution), ADR-001 (declared in code), ADR-049 §3 (the budget); issues #41, #198, #25, #200

## Context

The API's limits are fixed windows in memory (ADR-026): 120 requests a minute per address until a guard admits a request, then per person, and the sign-in doors' window per address. They refuse cheaply, but a refused request still reaches the box: CloudFront forwards it, Traefik routes it, Node parses it, answers it and writes a log line. ADR-026's Consequences leave volume to "the edge rule of #41". A flood from one address spends the box's CPU and its burst credits, and holding the table of sign-in attempts at its ceiling takes some eighty starts a second, a real share of the database's two burstable cores.

Since #198, everything the box serves on 443 comes through the one distribution of `modules/media`: the API, Dokploy's control plane and the previews. So a web ACL on that distribution sees every request that comes through it before the box does. Not every request the box gets comes that way: its 443 admits every CloudFront distribution's servers (ADR-008, History of 2026-11-06), and its port 80 serves the ACME challenge and the redirect to HTTPS. AWS WAF is the only rate limiter at the edge. A CloudFront Function keeps no state from one request to the next, and Shield Standard, on for every distribution, answers floods at the network's layers, not a stream of well-formed requests.

## Decision

1. **One web ACL per distribution, `kuutti-<env>-edge`, with one rule.** It is part of `modules/media`, beside the distribution it guards (`edge.tf`), so production's comes with its cutover (#25) and staging runs what production will. A CloudFront web ACL lives in us-east-1, as the distribution's certificate does.
2. **The rule refuses an address past 2,000 requests in any five minutes.** The number is the maintainer's of 2026-11-06, set per environment in `envs/<env>/main.tf` (`edge_requests_per_five_minutes`). The address is the one CloudFront took the connection from, never a header a client wrote.
   - Counted is everything the distribution sends to the box, with two exceptions, both read from `modules/media/edge.json` beside the rule:
     - **A signed photo:** a path of the one shape the API signs, `/media/<sha256>/<variant>.webp`. CloudFront serves it from its cache or the bucket, never from the box, and photos are the most a person browsing asks for. Only that shape is left out, because CloudFront picks a behaviour on the path it has normalised and sends the raw path on, and the box resolves it too. A prefix would let `/media/../health` reach the box uncounted; the shape has nothing in it to normalise.
     - **The two sign-in starts,** `/auth/start` and `/admin/auth/start`, by their exact paths. The API refuses a start itself, with a redirect back to the app or the panel, so that nobody is left on a JSON page in the system browser (ADR-026 §4). The edge's 429 would leave them on one. `identity/edge.test.ts` holds the two paths to the API's starts.
   - 2,000 in five minutes is about seven requests a second: more than three people at the API's own ceiling of 120 a minute each, and many more at the pace people use the app.
   - AWS says it can take up to several minutes, usually under thirty seconds, to begin refusing an address that crosses the limit. It lets the address through again once its count over the last five minutes is under the limit.
3. **The refusal is the API's own `rate_limited`:** 429, `Retry-After: 300`, and the API's envelope, whose `requestId` is `edge` since no request reached the box. The app gives `rate_limited` its own text, and the load smoke stops at its first 429 of any kind; `lib/rate-limit.test.ts` holds the body to the limiter's own 429. The panel's calls carry a session header, so its browser asks first with a preflight, and to the panel a refused preflight is a network error. AWS's default refusal would be a 403 with an HTML page.
4. **No logs and no sampled requests.** A WAF log writes each request's address, and nothing in it can redact one. Sampled requests keep up to three hours of requests, each with its address and every header, a session's bearer token among them, and CI's plan role could read them through ReadOnlyAccess. So the web ACL publishes metrics alone: counts per rule, with no address. In the bootstrap the plan role is denied `wafv2:GetSampledRequests` and `wafv2:GetRateBasedStatementManagedKeys`, the list of addresses the rule is refusing now. Those are data, not configuration, as ADR-066's store is. The bootstrap is applied before the rule first refuses anybody: from the pull request's branch before the merge, or at the latest before staging's burst test.
5. **The load smoke's runner is not counted for its hour.** `docs/runbooks/capacity.md` drives staging from one laptop at 30 to 60 requests a second, far past what any address should send.
   - An IP set, `kuutti-<env>-edge-unlimited`, is declared empty, and the rule leaves out the addresses it holds.
   - The runner's address is written into it with the CLI before a run and removed after it, by the runbook's commands. OpenTofu ignores its contents, so the address never enters the repository.
   - An IP set holds one family. The set is IPv4's, and the run goes over IPv4; a runner with IPv6 alone would need a set of its own.
   - During the hour the address is not secret. A pull request's plan reads the set as it refreshes it, so a job of any pull request of this repository could print it. CloudTrail's event history keeps the update, address included, for 90 days, which the plan role may not read.
   - An apply during the hour would write the address into the state, so merges that touch `infra/` wait for the hour.
   - The shell that runs the load smoke empties the set when it exits, by a `trap`, so a forgotten step does not leave an address exempt.
6. **Two alarms, both mailing the alert address.**
   - `kuutti-<env>-edge-rate-limited` mails at any refusal within five minutes, since no person browsing reaches the limit. It lives in us-east-1, where WAF publishes a CloudFront web ACL's metrics, and mails through the probe's topic.
   - `kuutti-<env>-api-refusals` mails at 100 refusals by the API within five minutes. It counts the 429s of the request line, the windows' and the day's budgets', and the `sign-in refused` lines of ADR-026 §7, whose starts answer 302.
   - A saved Logs Insights query, `refusals-by-route`, says which limit refused. What each layer catches, and what to do when one mails, is `docs/runbooks/abuse.md`.

## Consequences

- About 6 USD a month per environment: 5 for the web ACL, 1 for the rule, 0.60 per million requests. Staging pays from now and production from its cutover. With both, the two environments come to about 117 to 122 USD a month at list price, around the 80 % alert of ADR-049 §3's budget (120 USD), so an ordinary month may mail it.
- People behind one address share the edge's 2,000, signed in or not. The API gives a signed-in request back to the address (ADR-026 §2); the edge cannot, since it does not know who is asking. A campus or a mobile network that puts many people browsing at once behind one IPv4 address may see the edge's 429 for up to five minutes after its busiest stretch.
- An IPv6 client counts by its address, not by its /64 as the API counts it, so a client that walks its /64 is not held by the edge; the API's windows hold it (ADR-026 §1). A flood from many addresses, each under 2,000, passes the edge as well; the API's windows, the doors and the table's ceiling hold it (ADR-026). The edge is for volume from one address.
- AWS holds each address's count for the five minutes it looks back, and an address it is refusing in the rule's list for as long as the refusal lasts. Kuutti stores none, writes none down and links none to an account. The privacy notice on kuutti.app says that the server uses a request's address, in its memory only, to refuse a sender that asks too much too fast; the edge now does the same, for minutes. Its wording is the maintainer's.
- A request through somebody else's distribution, or one to the box's own port 80, never meets the web ACL. The API counts the first in the one bucket of no address (ADR-066 §4), `/openapi.json` included since 0.110.4. `/health` is the one path no window counts, and it begins a check of the database at most once a second in each process, however many ask (ADR-026, History of 2026-11-06, #630). Port 80 serves only the ACME challenge and the redirect.
- A flood of sign-in starts from one address reaches the box. The API's address window and the doors refuse it before anything is written or signed (ADR-026 §4), but each refusal still costs a request and two log lines.
- The chat's WebSocket counts once, at its upgrade; its frames are not requests.
- Dokploy's control plane and the previews share the rule with the API: the maintainer's browser on Dokploy counts with the phones on the same network.
- A new number is a pull request and an apply: staging at the merge, production at its tag. It is not a parameter and a restart like the API's numbers (ADR-026 §5). Changing a rate rule pauses its counting for up to a minute (AWS).
- The edge alarm counts the whole web ACL (its `Rule` dimension is `ALL`), so a rule added later that refuses mails through it too.

## Left out on purpose

- **AWS's managed core rule set in count mode**, which #41's body proposed. Count mode only counts, and with no logs and no samples (§4) nobody could see what it matched. Its body-size rule would count every photo upload. It costs 1 USD a month and 700 of the web ACL's 1,500 capacity units. It is worth adding once there is an attack it would have blocked and a way to read its matches without keeping addresses.
- **Refusing the starts at the edge with the API's redirect:** the rule would count without refusing and label what it counts, and a rule per answer would follow it, a 302 to the app's link for `/auth/start`, one to the panel for `/admin/auth/start`, and the 429 for the rest. That is three rules more, about 3 USD a month per environment. It is worth it once a flood of starts from one address costs the box enough to matter.
- **A rule of the sign-in doors' own:** the API refuses a start before it writes or signs anything (ADR-026 §4). A second rule would count the same address twice, for one more dollar a month.
- **Bot Control, CAPTCHA and challenges:** paid, and a challenge is a web page that the app cannot answer.
- **CloudFront's flat-rate plans**, which include WAF. AWS's table of their features lists a key value store, which ADR-066's function reads, from the Pro plan up, and a custom origin request policy, which the ACME path has, from Business up.
- **A web ACL on the panel's distribution:** static files from a bucket, with no box behind them.
- **Refusing by country:** people travel, and a VPN takes the country of its choice.

## History

- 2026-11-06 (#41): proven on staging by the burst test of `docs/runbooks/abuse.md`. The edge refused from about 3,000 requests and 74 s in, and both alarms mailed. The test also showed two things the first version had wrong. AWS's list of the addresses the rule was refusing stayed empty while it refused one, so the runbook no longer leans on it. And the edge alarm stayed in ALARM long after the last refusal, since WAF publishes no zero, so it alarms on `FILL(blocked, 0)` instead (§6). Version 0.110.6.
