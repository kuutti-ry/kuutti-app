# Capacity: five thousand people on one box, measured

CLAUDE.md sizes everything at five thousand people on one box (TD-3, TD-19). That is a claim until it has been measured. Once per milestone, by hand, `pnpm load:smoke` drives staging the way five thousand people would in a bad hour, and the row it prints goes into the table at the end with what the server showed meanwhile (#200). The beta is the wrong moment to learn the ceiling.

**The first run waits for #77's memory alarm** (the maintainer's word, 17/10/2026). Until a run has happened, the table holds no numbers.

## What a run is

A **visit** is a person opening the app and looking at their profile. Opening the app asks for the onboarding status, then the home's gate. The profile view asks for the profile and the photo list. On one visit in N the person also opens the photos screen, which reads the list again and asks for one signed URL per thumbnail (ADR-008). The public part goes out at the visit's start: every second visit asks for the waitlist counter, whose answer is cacheable for an hour. Every fourth visit sends the sign-in's last step, `POST /auth/exchange`, with a code nobody holds: the exchange's shape without the bank (a hash and an indexed lookup, answered `auth_code_used`). In the app, the waitlist goes out alongside the gate, after the onboarding answer, and the profile is a screen many openings never reach. The visit's make-up is an assumption, like the bad hour below. A run without sessions sends the public part alone.

**N is set by the exposure budget, not by the app.** Each account may use 60 thumbnail URLs in one run, a tenth of its day's 600, and the script spreads them over the run. In the app, every opening of the photos screen asks for a URL per photo. The URL route is the visit's costliest: a lookup, then a transaction with an advisory lock, a count over the day's rows and an insert, then an RSA signature on the event loop. With the recipe below (seven accounts of six photos, five stages of a minute), N is 18, about a third of a URL per visit. The script prints N and the URLs per visit, and the row records both. If the URL route's ceiling matters, give it more of the run: more test persons, a shorter run, or a short stage of its own.

A **stage** offers visits at a fixed rate for `--stage` seconds. It is an open model: a visit that finds every request slot (`--concurrency`) busy is counted as dropped, never queued, so slow answers show up in the numbers instead of slowing the offer. After each stage the script prints the visits, the parts held back, the requests answered a second and how many were thumbnail URLs, p50, p95, p99 and the maximum, the timeouts, the p95 of each route, and every answer that was not the expected one by route, status and error code. A request unanswered after 10 s counts in the percentiles at 10 s, so a p95 with timeouts in it is a lower bound.

The run ends after the first stage that **bends**: its p95 over `--stop-p95` (1,000 ms unless given), more than 1 % of its answers errors, or more than 1 % of its visits dropped. It also ends after a stage that held back more than 1 % of its visits' parts for a resting budget (below). That stage sent less than its rate, so it is **not measured**, neither held nor bent. The last stage before the end **held**.

Stage 1 also pays for setting up the connections: the runner's TLS handshakes to CloudFront, up to `--concurrency` of them, and the API's database pool, which connects as it is needed. Its numbers are slightly worse than the box's, so start low, as the recipe does. A run that bends at its first stage has bent anyway.

**The bad hour, as this page counts it.** This is an assumption, and the maintainer's to change. Every one of the five thousand opens the app twice in the hour, and a third of the hour's visits fall in its busiest ten minutes. That makes 10,000 visits, 3,300 of them in 600 seconds: about 5.6 visits a second at the peak, some 30 to 60 requests a second by a visit's shape. A run that holds at 6 visits a second, by the table's held column, has measured the claim. The stage where it bends is the ceiling.

## Before a run

1. **#77 is done.** The box pushes its free memory every minute, an alarm mails under 200 MB, and the alarm has its row in `alerts.md`. On 2026-09-27 the box ran out of memory with Dokploy, the API and three previews on it. A load run is how that would happen again, so nobody runs one without that alarm.
2. **The release to measure is on staging.** `curl -sS https://api.staging.kuutti.app/health` shows its version and commit, and the script prints them too.
3. **The box is quiet.** No preview is building or deploying: the previews share the box (ADR-012). The burst credits of the box and of the database are not low (the two `cpu-credits-low` rows of `alerts.md`). Staging runs `cpu_credits = standard`, so a box out of credits slows to its baseline, and the run would measure the baseline rather than the box.
4. **The team knows.** On staging the API's address limit counts the CloudFront edge, which every phone near it shares (ADR-008 History). A run spends part of that window. Its last stage may also set off `kuutti-staging-api-5xx` (below), so the team expects that mail.
5. **The sessions file** is made (below).
6. **The limit is decided** (below). With the default of 120 a minute, the run stops short of one visit a second.

## Sessions

The load signs nobody in. It has no door of its own into the API, and none is made for it. The people on staging are Telia's test persons (ADR-018), and a session is what a sign-in at Telia's test bank gives. So the sessions are made by hand: the product's own sign-in, walked with `curl`. They are kept outside every git work tree, in a file of refresh tokens, one a line, under a line that names the API they belong to. A file for staging and one for this computer never share a path:

```sh
api=https://api.staging.kuutti.app; file=~/.kuutti-load-sessions-staging
# a rehearsal here: api=http://localhost:3000; file=~/.kuutti-load-sessions-local (the bank is the mock)
[ -e "$file" ] || (umask 077; printf '# target %s\n' "$api" > "$file")
verifier=$(openssl rand -hex 32)
challenge=$(printf %s "$verifier" | shasum -a 256 | cut -d' ' -f1)
curl -sS -o /dev/null -w '%{redirect_url}\n' "$api/auth/start?platform=ios&locale=fi&code_challenge=$challenge"
```

1. Have the exchange below ready to paste. Open the printed address in a private browser window with the developer tools' network tab open, and sign in at the test bank as one of the test persons (`docs/vendors/telia.md` 1.4; locally, the mock bank's buttons are the personas).
2. The last request, `/auth/callback`, answers 302 to `kuutti://auth?code=…`, which the browser cannot follow. Copy the code, 43 characters, from its `Location`.
3. Exchange the code **within sixty seconds of the callback**. After that, the exchange answers `auth_code_used`, and the sign-in starts again from the top:

```sh
read -r code                              # paste the code
curl -sS -A kuutti-load-smoke "$api/auth/exchange" -H 'content-type: application/json' \
  -d "{\"code\":\"$code\",\"verifier\":\"$verifier\"}" \
  | node -e 'const a = JSON.parse(require("fs").readFileSync(0, "utf8")); if (!a.refreshToken) { console.error(a.error?.code ?? "no session"); process.exit(1); } console.log(a.refreshToken)' >> "$file"
```

Repeat this for each test person with a live account, and for most of them more than once. More sessions add no budget: a person's budget is the account's, and all of its sessions share it. But every signed-in request writes its own session's row (`last_used_at`), and five thousand people write five thousand rows. Seven sessions would put all of the run's writes on seven rows. The script goes round an account's sessions, so two to four each spread that write at no cost to the budget. Each sign-in spends one start of the doors' sixty a minute (ADR-026 §4) and adds a `kuutti-load-smoke` device to that person's sessions.

**How the script uses the file:**

- At its start it rotates every token and writes the new one back before it asks for the next, so the file serves the next milestone too, until the refresh tokens expire after 90 days. A session the API refuses is commented out with the day, not deleted, and the script says which line.
- Before it asks anybody anything, it refuses:
  - a file without its `# target` line, or one naming another API than `--target`. An API answers another's token the same as an ended one (`session_revoked`), so without the check, a file pointed at the wrong API would lose every session;
  - a file inside any git work tree, this checkout's or another's;
  - a file others can read, a line that is not a refresh token, and a token given twice (a refresh token presented twice ends its session, #35).
- It never prints a token, an account or a photo id.

Never put a phone's session in the file: rotating it would sign the phone out at its next refresh (reuse, #35). The file holds bearer tokens for test persons; delete it when a milestone's runs are done unless it is to be kept.

## The limit

The script plans each stage against the budgets the API reports in `RateLimit-Limit`, taking at most 40 % of each window, and refuses a plan that would take more. The other 10 % up to half is for the sessions' opening requests and a persona's own phone, so a stage planned to the full ceiling does not trip the rest at half (below). The refusal names the most visits a second the sessions allow, and the `rate-limit-per-minute` a plan needs. With seven accounts and the default 120 a minute, that is about 0.7 visits a second.

To find where the box bends, the maintainer raises `/kuutti/staging/rate-limit-per-minute` for the hour. ADR-026 §5 makes the number his; it is read at boot, so a restart of the API applies it, and the value goes back, with another restart, after the run. The one number is both the address's limit and each person's, so for that hour staging's public routes are less protected. That is why a run is announced and short.

## The run

```sh
pnpm load:smoke -- --target https://api.staging.kuutti.app --confirm-staging \
  --sessions ~/.kuutti-load-sessions-staging --rates 1,2,4,6,8 --stage 60
```

| option | what it does | default | at most |
|---|---|---|---|
| `--target` | the API: `http://localhost:3000` (or `127.0.0.1`, `[::1]`), or `https://api.staging.kuutti.app` | required | |
| `--confirm-staging` | required for staging, refused anywhere else | | |
| `--sessions` | the sessions file; without it, the public part of each visit alone | none | 50 sessions |
| `--rates` | visits a second, one stage each | `0.5` | 8 stages, 20 a second each |
| `--stage` | seconds per stage | 60 | 300, and 600 for the whole run (an access token lives fifteen minutes and is refreshed once, at the start) |
| `--concurrency` | requests in flight | 16 | 64 |
| `--stop-p95` | the p95 in ms past which a stage has bent | 1000 | 10,000 |
| `--self-test` | the command line, the refusals, the sums, and runs against a stand-in on this computer of every guard below (CI's lint job) | | |

What it refuses before any load:

- Production, by name (`api.kuutti.app`), and any other host but these two. That includes the previews: they share staging's box, and have no bank.
- `APP_ENV=production` in its own environment, and an `APP_ENV` that disagrees with the target.
- A sessions file it must not take (above).
- An API that does not answer `/health` as ours and ready.
- An API that does not serve `/openapi.json`, which production alone withholds (`app.ts`).
- A plan over the budgets (above).

It exits 0 when it ran, 1 when it refused, and 2 when a guard stopped it. A run that ran prints its row whether a stage bent, was not measured, or neither. After an exit 2 the numbers are not a measurement, and there is no row.

A local run (`pnpm env:up`, `pnpm demo:reset`, sessions from the mock bank in their own file) is a rehearsal of the procedure. It measures a laptop, not the box.

## The budgets it keeps

The run's whole rate comes from one address. What it does to each budget:

| budget | on staging | what the run spends |
|---|---|---|
| the sign-in doors, `/auth/start` and `/admin/auth/start`, per address (ADR-026 §4) | 60 a minute | nothing. The run never starts a sign-in, so it cannot lock a persona out, and `auth_request`'s ceiling (§6) is untouched. The sessions were made by hand beforehand, one start each |
| the address: every request until a guard admits it, given back once the person's limiter counts it (§1, §2) | `rate-limit-per-minute`, 120. The address is the CloudFront edge, which the team's phones share | the public requests (the waitlist, nobody's exchange, one refresh per session at the start), and the signed-in requests in flight, which hold the address's count until answered. Planned to 40 % of the window, with `--concurrency` counted in full |
| each person: every request a guard admits, per account across its sessions (§1, §3) | the same number | visits go round the accounts, planned to 40 % of each account's window, so a persona's own phone keeps more than half |
| the exposure budget, per account per Finnish day (ADR-008 §1, `photo_fetches_per_day`) | thumb 600, card 300, full 60 | thumbnails only, at most 60 per account per run, spread over the run; card and full never |
| the 5xx alarm, `kuutti-staging-api-5xx` | five in five minutes | the run stops sending at its third server error or unanswered request. The requests already in flight, up to `--concurrency`, still finish, and at the bend they tend to fail together (a full pool fails every waiting request). So the alarm may mail at the bend: that is expected, and announced |
| the WAF rate rule of #41 | not in place on 17/10/2026 | once it is, the run's whole rate counts against it from one address. The maintainer scopes the rule down for the runner's address for the hour, or keeps the run under it |

The plan is backed by guards as the run goes:

- An answer with less than half its window left (`RateLimit-Remaining`) rests that budget for a window: the person's on a signed-in route, the address's on a public one. The stage counts what it held back, and a stage that held back more than 1 % of its parts is not measured.
- The first 429 of any kind stops the run with exit 2: `rate_limited`, or `photo_budget_exceeded`, whose alarm counts 100 a day.
- So does the first 401 of a session.

## While it runs: what to watch

The script measures from outside: its p95 includes the network from the runner to CloudFront. The server's side is in CloudWatch, for the stages' minutes; the script prints each stage's start in UTC. These commands are the maintainer's (`pnpm aws:login` first). `<id>` is `tofu output instance_id` in `infra/envs/staging`.

- **The box's own p95 per route:** the Logs Insights saved query `kuutti-staging/p95-duration-by-route` over the run's window. Its `durationMs` starts when Hono takes the request, so it leaves out the time a request waited for the event loop.
- **The event loop.** The API is one Node process (`CMD ["node", "dist/index.js"]`, no cluster), so its JavaScript runs on one core: JSON and zod, the logger, the URL signatures. On the two-core box, one core flat out shows as about 50 % `CPUUtilization`, not 100 %. When the event loop is what bends, the box sits near 50 %, the database's connections stay under the pool's size, the log's p95 stays flat, and the script's p95 climbs. The gap between the two p95s is the time spent waiting for the loop.
- **Postgres connections:** RDS `DatabaseConnections`. The API's pool is `DB_POOL_MAX` (10 unless set), and each preview has its own. When the pool is what bends, the connections sit at the pool's size while p95 climbs and the database's CPU does not.
- **The database:** RDS `CPUUtilization` and `CPUCreditBalance`. Staging's database is a db.t4g.micro and production's a db.t4g.small, so staging's ceiling there is a lower bound for production's.
- **The box:** EC2 `CPUUtilization` and `CPUCreditBalance` (a t4g.small, two cores; see the event loop above), and the free memory of #77's metric.
- **sharp and the WebSocket count:** not driven yet (below).

```sh
from=2026-10-20T18:00:00Z; to=2026-10-20T18:06:00Z     # the first stage's start and the run's end
aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name DatabaseConnections \
  --dimensions Name=DBInstanceIdentifier,Value=kuutti-staging --statistics Maximum \
  --period 60 --start-time "$from" --end-time "$to"
```

The same command with `--metric-name CPUUtilization` and `CPUCreditBalance` covers the database. With `--namespace AWS/EC2 --dimensions Name=InstanceId,Value=<id>` it covers the box.

## After the run

1. Put the script's row in the table. Fill the milestone, the log's p95 at the bend, what bent first, and the three server columns.
2. Set `rate-limit-per-minute` back and restart, if it was raised.
3. If `kuutti-staging-api-5xx` mailed, check in `kuutti-staging/errors-by-route` that its 5xx fall in the run's last stage, and say so to the team.
4. If the first thing to bend is a surprise, open an issue for it.

## The table

One row per milestone run. "held" is the last stage that held, and "bent" the first that did not, or the stage that was not measured, with why. A stage's cell is its visits a second, the requests answered a second, and the p95 in ms, all the script's; any parts held back or timeouts follow in brackets. "grid" is the photos screen's share: one visit in N, and the signed URLs a visit. The limit is `rate-limit-per-minute` during the run.

| date | milestone | version | target | accounts · sessions · limit | grid: 1 in N · URLs a visit | held: visits/s · req/s · p95 ms | bent: visits/s · req/s · p95 ms (why) | log p95 ms at the bend | first to bend | DB connections, max | box CPU % · free MB | DB CPU % · credits |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

## What the run leaves out, and what would make it needed

- **The sign-in's start and the bank's callback.** A start writes an `auth_request` row and has a request object signed, and the doors let one address start sixty a minute. The callback is the bank's. This would be needed for a launch's sign-up wave: then a measure of the start alone, within the doors, apart from this run.
- **The refresh.** The app refreshes its access token when it has under thirty seconds of its fifteen minutes left, so in the bad hour nearly every opening sends `POST /auth/refresh` too. That is a public request, counted in full on the address, and an update that rewrites two uniquely indexed hashes of the session's row. The run refreshes each session once, at its start, and never mid-run: a rotation whose answer is lost, as at a bend, would leave the file with a retired token, and presenting that one ends the session (#35), which costs a sign-in at the bank. So the measured ceiling is optimistic by about one write a visit. This would be needed if the database is what bends first: then a refresh stage with sessions made for it alone.
- **Uploads, sharp's concurrency.** The pool re-encodes `IMAGE_CONCURRENCY` pictures at once (the core count, two on staging's box) and refuses the next with 503 `media_busy` rather than queue it. So its ceiling is known by construction, and the time a picture takes is `POST /photos`'s `durationMs` in the log. A driven upload would add photos to the test persons, cost three Rekognition calls each on staging (two when the scene call fails), and count its refusals toward the 5xx alarm. This would be needed before a launch, when people onboarding upload three to six pictures each: then an upload stage with the alarm in mind.
- **Writes** to the profile, the preferences or the consents. They would change the test persons' answers, which the demo shows.
- **The round and the chat.** They have no routes yet (M4), and the WebSocket count comes with the chat.
- **Many addresses.** The run comes from one, so the address limit it meets is the runner's, not five thousand people's.
- **Many people.** The run is a handful of accounts and sessions. Their rows are hot: every signed-in request updates its session's row, and the URL route locks per account, so a few rows take all the writes and queue on each other as latency rises. Their data is a few pages the database keeps cached. Five thousand people spread the writes over five thousand rows and need a working set that may not fit. Where the run bends is then neither their best case nor their worst. More sessions per person (above) spread the session writes. The synthetic population (`demo:population`) makes the tables population-sized, but none of its people can sign in (no bank login maps to them), so the driven reads stay on the test persons' rows. This would be needed if the run's ceiling comes close to the claim: then sessions for many more test persons.
