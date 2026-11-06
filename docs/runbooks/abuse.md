# Abuse: the limits, a flood, and what to do

Kuutti's limits in the order a request meets them, what each one catches, how a flood shows, and how to move a number (#41). The reasoning is ADR-026 (the API's windows), ADR-067 (the edge) and ADR-008 (the exposure budget). `<env>` is `staging` or `prod`, `<id>` the box's instance id (`tofu output -raw instance_id` in `infra/envs/<env>`). The AWS commands need the maintainer's session (`pnpm aws:login`). Production's edge exists from its cutover (#25).

Nothing here stores or logs an address (ADR-026 §7, ADR-067 §4). The edge keeps a count per address for five minutes and, while it refuses an address, that address in a list. Read that list if you must, and write nothing of it down.

## The layers

| layer | what it counts | the number | what it answers | what mails |
|---|---|---|---|---|
| Shield Standard, AWS's, on every distribution | floods at the network's layers | AWS's | nothing reaches the distribution | nothing of Kuutti's |
| The edge's rate rule (ADR-067) | every request the distribution sends to the box, per address, except a signed photo's path (`/media/<sha256>/<variant>.webp`), the two sign-in starts and the load runner's address for its hour | 2,000 in five minutes, `edge_requests_per_five_minutes` in `infra/envs/<env>/main.tf` | 429 `rate_limited`, `"requestId":"edge"`, `Retry-After: 300`, until the address's count over five minutes is under the limit | `kuutti-<env>-edge-rate-limited` (us-east-1) |
| Signed URLs (ADR-005) | a photo under `/media/` without a valid signature | 15 minutes, 20 for a photo sent in a conversation | 403 from CloudFront | nothing |
| The address's window (ADR-026 §1, §2) | every request until a guard admits it; a signed-in request gives its count back | 120 a minute, 30 on a preview; `/kuutti/<env>/rate-limit-per-minute` | 429 `rate_limited`, on the request line with `route` `/*` and no account | `kuutti-<env>-api-refusals` |
| The person's window (§1, §3) | every request a guard admits, per account or staff identity | the same number | 429 `rate_limited`, the line names the account | the same |
| The sign-in doors (§4) | `/auth/start` and `/admin/auth/start` per address, IPv6 by its /56 | 10 a minute in production, 60 elsewhere; `/kuutti/<env>/sign-in-rate-limit-per-minute` | 302 to the app or the panel with `error=auth_rate_limited`, and a `sign-in refused` line, `detail.limiter` `address` | the same |
| The table of attempts (§6) | sign-in attempts the bank has not answered | 50,000 rows | the two oldest unanswered attempts go, a `sign-in refused` line with `detail.limiter` `evicted` | the same |
| The day's budgets | photo fetches, likes, cards, messages and the rest, per account | `matching_config`, in the panel under `/config` | 429 with the budget's own code | `kuutti-<env>-photo-budget-refusals` for photos; the refusals alarm for all |
| The velocity rules (ADR-041) | reads of the queue and photos of people's cards, per account | `matching_config` | a shadow ban by the machine (ADR-033), whose `audit_log` row has no actor | nothing |

The edge is for volume from one address. A flood from many addresses passes it, each under the limit, and the API's windows, the doors and the table's ceiling hold it. So does a flood of sign-in starts, which the edge leaves to the API's redirect (ADR-067 §2), and anything sent through somebody else's distribution, which never meets the edge. The API counts that in the one bucket of no address, `/openapi.json` included; `/health`, which no window counts, begins a check of the database at most once a second in each process, however many ask (ADR-026, History of 2026-11-06). An IPv6 client is counted by its whole address at the edge and by its /64 at the API. Signed in or not, everybody behind one address shares the edge's number; only the API can tell people apart.

## When the edge's alarm mails

`kuutti-<env>-edge-rate-limited` says the edge refused at least one request in five minutes. No person browsing gets there, so it is a script, a flood, or many people behind one address. Its OK comes once five minutes pass without a refusal.

1. How long and how much, a minute at a time over the last hour:

   ```sh
   for m in BlockedRequests AllowedRequests; do
     aws cloudwatch get-metric-statistics --region us-east-1 --namespace AWS/WAFV2 --metric-name "$m" \
       --dimensions Name=WebACL,Value=kuutti-<env>-edge Name=Rule,Value=ALL --statistics Sum --period 60 \
       --start-time "$(date -u -v-1H +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
       --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Sum]' --output text
   done
   ```

2. What reached the box before the edge began: the API's refusals of those minutes, below. AWS can take up to several minutes to begin refusing, usually under thirty seconds.
3. How many addresses, while the refusal lasts: the list is gone once it ends.

   ```sh
   id=$(aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1 --query "WebACLs[?Name=='kuutti-<env>-edge'].Id" --output text)
   aws wafv2 get-rate-based-statement-managed-keys --scope CLOUDFRONT --region us-east-1 \
     --web-acl-name kuutti-<env>-edge --web-acl-id "$id" --rule-name requests-per-address \
     --query '[length(ManagedKeysIPV4.Addresses), length(ManagedKeysIPV6.Addresses)]'
   ```

   The command counts them. Leaving off `--query` shows them: that is the maintainer's to do, never in an agent's session, where the addresses would reach the model's transcript. One address is one sender, or many people behind one network. Many addresses at once is a flood the API's windows also carry.
4. People refused: the edge cannot tell them from a script. Somebody writing to hello@ about "too many requests" from a campus or a phone network is the sign; then raise the number (below).

## When the API's refusals alarm mails

`kuutti-<env>-api-refusals` says the API refused 100 or more requests within five minutes: 429s on the request line, the windows' and the day's budgets', and `sign-in refused` lines.

1. Logs Insights, saved query `kuutti-<env>/refusals-by-route`, over the alarm's minutes. `route` `/*` with `signedIn` 0 is the address's window. A route with `signedIn` 1 is a person's window, or a day's budget on that route: the code is in the answer, not on the line. A `sign-in refused` row names its limiter: `address` for one address starting many sign-ins, `evicted` for a flood of starts from many addresses (the table is full, ADR-026 §6), `cap` for a table full of answered attempts, which does not happen in use.
2. One account behind many refusals is a script under a person's account. Over the same minutes in Logs Insights: `filter msg = "request" and status = 429 and ispresent(accountId) | stats count() as refusals by accountId | sort refusals desc | limit 10`. Suspend it (`incident.md`, One person).
3. Many accounts on one route, one platform, is a loop in a build that asks again at a 429: a fix in the app, not a limit.
4. On staging a preview logs to the same group, with its own window of 30 a minute; the line's stream names its container.

## Moving a number

- **The edge:** `edge_requests_per_five_minutes` in `infra/envs/<env>/main.tf`, in a pull request. Staging applies at the merge, production at its next tag, behind its approval. AWS pauses the rule's counting for up to a minute while the change lands.
- **The API's windows:** parameters read at boot, so no deploy of new code: `aws ssm put-parameter --name /kuutti/<env>/rate-limit-per-minute --type String --value <n> --overwrite`, or `sign-in-rate-limit-per-minute`, then redeploy the API in Dokploy, which restarts it on the same image (`incident.md`, Scraping and floods). Both numbers are the maintainer's (ADR-026 §5).
- **The day's budgets:** the panel under `/config`, a new version with a reason. They hold from the next request.
- **The load smoke's runner:** `capacity.md`, Before a run, step 8. Its address goes into the edge's allow list for the run's hour and out after it.

## The burst test

Proof that the edge refuses and that both alarms mail (#41, as #29's probe test did for its alarm). From a laptop, once the team knows: for about five minutes the laptop's address, and everybody's behind it, is refused on staging, its API window included.

```sh
url=https://api.staging.kuutti.app/media/../edge-check-404
for i in $(seq 1 60); do
  seq 1 100 | xargs -P 20 -I{} curl --path-as-is -s -o /dev/null "$url"
  if curl --path-as-is -s "$url" | grep -q '"requestId":"edge"'; then echo "the edge refuses after about $((i * 100)) requests"; break; fi
done
curl --path-as-is -s -D - -o /dev/null "$url" | grep -i -E '^(HTTP|retry-after)'
```

The path goes to the box: CloudFront picks the default behaviour for the path it has normalised, and the box resolves the dot segment to a path the API does not know, a 404 without the database. `--path-as-is` keeps curl from resolving it first. That the edge refuses it after about 2,000 shows both that the rule counts and that a `/media/` prefix gets nobody past it (ADR-067 §2). The address's window counts it too, so the API's 429s come first, from its 121st request in the minute. The last line shows the edge's 429 with `Retry-After: 300`. Within five minutes `aws cloudwatch describe-alarms --region us-east-1 --alarm-names kuutti-staging-edge-rate-limited --query 'MetricAlarms[0].StateValue'` says `ALARM`, and so does `kuutti-staging-api-refusals` in eu-central-1, from the API's own 429s. Both mail, and both mail OK some five to ten minutes after the loop stops.
