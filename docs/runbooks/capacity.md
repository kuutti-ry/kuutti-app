# Capacity: five thousand people on one box, measured

CLAUDE.md sizes everything at five thousand people on one box (TD-3, TD-19). That is a claim until it has been measured. Once per milestone, by hand, `pnpm load:smoke` drives staging the way five thousand people would in a bad hour, and the row it prints goes into the table at the end with what the server showed meanwhile (#200). The beta is the wrong moment to learn the ceiling.

**The first run, 10/11/2026**, on 0.118.3 with six accounts, in three passes: up to 8 visits a second and then up to 20 with `rate-limit-per-minute` at 3,000 for the hour, and up to 50, the script's cap since #652, at 6,500 (the maintainer's numbers). No pass had an error, a timeout or a 5xx, and 24 sockets stayed open to the end of each. The bad hour below peaks at 5.6 visits a second; at 6 the script's p95 was 108 ms and the server's 25 ms, so the claim is measured, with room. **The ceiling is about 50 visits a second, some 260 requests a second, nine times the bad hour.** At 50 the stage still held by the script's rules (p95 228 ms, 27 of 3,000 visits dropped), so the bend itself lies just past it. What gave first:

- **The API's one core.** Its container rose from about a fifth of a core at 8 visits a second to half at 25 and a full core at 50 (100, 102 and 109 %), and there the event loop is what bent (While it runs): the script's p95 tripled from 77 to 228 ms, the log's went from 25 to 109 and then 256 ms, and its p50 from 15 to 93 ms in the stage's last seconds.
- **Not the database.** Its pool sat at its 10 connections from 4 visits a second on, held by requests waiting on the loop, while its CPU rose only to 41 % at 50.

The costly routes were the queue's read (log p95 621 ms in the third pass, p50 69 ms) and the signed URL (167 ms). Everything in What the run leaves out applies: staging held 106 complete people, the reads decided nothing, and six accounts are not five thousand people. What a second process would change is Past the one core, below. The run's full record, with its sign-in helper, is a comment on #200.

## What a run is

A **visit** is a person opening the app, reading the queue and looking at their profile. Opening the app asks for the onboarding status, then the home's gate and the pond counter, the counter with the person's session, so it is answered for them and kept by nobody (ADR-013 §18). On every visit, or on one visit in Q, the person then reads the queue once, `GET /queue/today` (below). The profile view asks for the profile and the photo list. On one visit in N the person also opens the photos screen, which reads the list again and asks for one signed URL per thumbnail (ADR-008). The public part goes out at the visit's start: every fourth visit sends the sign-in's last step, `POST /auth/exchange`, with a code nobody holds: the exchange's shape without the bank (a hash and an indexed lookup, answered `auth_code_used`). In the app, the profile is a screen many openings never reach. The visit's make-up is an assumption, like the bad hour below. A run without sessions sends the public part alone.

**N is set by the exposure budget, not by the app.** Each account may use 60 thumbnail URLs in one run, a tenth of its day's 600, and the script spreads them over the run. In the app, every opening of the photos screen asks for a URL per photo. The URL route is the visit's costliest: a lookup, then a transaction with an advisory lock, a count over the day's rows and an insert, then an RSA signature on the event loop. With the recipe below (six accounts, six photos at most, five stages of a minute), N is 21, under a third of a URL per visit. The script prints N and the URLs per visit, and the row records both. If the URL route's ceiling matters, give it more of the run: more test persons, a shorter run, or a short stage of its own.

**Q is set by the queue's alarm, not by the app.** Thirty reads of the queue a minute shadow-ban an account (`auto_shadow_ban_queue_reads`, ADR-041), and a run must never ban its own test persons. So the plan takes at most 40 % of that, as of every other budget, and past it the queue is read on one visit in Q, spread as the photos screen is. With the recipe below Q is 7. The script prints it beside N; the row does not carry it.

**What a read of the queue costs** (ADR-062, Consequences). A read comes in two shapes.

- With cards left, it reads the day's undecided entries, asks both people's filters of those people alone (`fitsNow`), serves at most ten cards through the card builder, which writes the shown record, and reads the person's budgets and their turn.
- With none left, it **walks the pool** first: `subjectsOfPond` reads every live account of the one pond with what its filters and completeness ask, the person's history and the likes waiting on them are read, the people left are ordered in memory, on the event loop, the inbox stop is counted, and the next people are written to the day's log, all in the request. One read walks at most three times (`FILL_TRIES`). Somebody at their queue's end walks once on every read, adding nobody.

So the walk comes every ten cards: a person going through three hundred cards a day walks the pool thirty times. Before the queue it came at most once a person a day, and the night built everybody else's queue days. One figure stands so far, taken on the laptop on 01/11/2026 with 4,617 accounts of `pnpm demo:population`, 3,361 of them complete, and the machine busy: a walk took about 360 ms (p95 430 ms), of which `subjectsOfPond` about 330 ms, and asking a page of ten cards fresh (`fitsNow`) about 4 ms. So a few walks a second is what a core holds. The first staging run did not replace it (10/11/2026, 106 complete people on staging): the route's p95 in the log was 150 ms up to 8 visits a second, 205 ms up to 20 and 621 ms up to 50 (p50 23, 35 and 69 ms), but which shape each read took the run cannot say, and most of its reads were the cheap one (What the run leaves out). `GET /queue/today` has its own p95 in the script's stage lines and in `kuutti-staging/p95-duration-by-route`, and that is where the cost is read.

A **stage** offers visits at a fixed rate for `--stage` seconds. It is an open model: a visit that finds every request slot (`--concurrency`) busy is counted as dropped, never queued, so slow answers show up in the numbers instead of slowing the offer. After each stage the script prints the visits, the parts held back, the requests answered a second and how many were thumbnail URLs, p50, p95, p99 and the maximum, the timeouts, the p95 of each route, and every answer that was not the expected one by route, status and error code. A request unanswered after 10 s counts in the percentiles at 10 s, so a p95 with timeouts in it is a lower bound.

The run ends after the first stage that **bends**: its p95 over `--stop-p95` (1,000 ms unless given), more than 1 % of its answers errors, or more than 1 % of its visits dropped. It also ends after a stage that held back more than 1 % of its visits' parts for a resting budget (below). That stage sent less than its rate, so it is **not measured**, neither held nor bent. The last stage before the end **held**.

Stage 1 also pays for setting up the connections: the runner's TLS handshakes to CloudFront, up to `--concurrency` of them, and the API's database pool, which connects as it is needed. Its numbers are slightly worse than the box's, so start low, as the recipe does. A run that bends at its first stage has bent anyway.

**The bad hour, as this page counts it.** This is an assumption, and the maintainer's to change. Every one of the five thousand opens the app twice in the hour, and a third of the hour's visits fall in its busiest ten minutes. That makes 10,000 visits, 3,300 of them in 600 seconds: about 5.6 visits a second at the peak, some 30 to 60 requests a second by a visit's shape. A run that holds at 6 visits a second, by the table's held column, has measured the claim. The stage where it bends is the ceiling.

## Before a run

1. **#77's alarm is in OK.** The box pushes its free memory every minute, and `kuutti-staging-memory-low` mails under 200 MB (ADR-046; its row in `alerts.md`). `aws cloudwatch describe-alarms --alarm-names kuutti-staging-memory-low --query 'MetricAlarms[0].StateValue'` says `OK`, which it does once the headroom document has run on the box (`infra/README.md`, The box's headroom). On 2026-09-27 the box ran out of memory with Dokploy, the API and three previews on it. A load run is how that would happen again, so nobody runs one without that alarm.
2. **The release to measure is on staging.** `curl -sS https://api.staging.kuutti.app/health` shows its version and commit, and the script prints them too.
3. **The box is quiet.** No deploy is under way. The burst credits of the box and of the database are not low (the two `cpu-credits-low` rows of `alerts.md`). Staging runs `cpu_credits = standard`, so a box out of credits slows to its baseline, and the run would measure the baseline rather than the box.
4. **The team knows.** On staging the API's address limit counts each viewer's address since 2026-11-06 (ADR-066), so a run from one laptop spends that laptop's window, not the team's. Before that it counted the CloudFront edge, which every phone near it shared (ADR-008 History). Its last stage may also set off `kuutti-staging-api-5xx` (below), so the team expects that mail.
5. **Matching is open for the test persons.** The demo commands open it on staging (ADR-060 Open 1). A person whose matching is not open, or whose profile is not complete, is answered before the pool is read, so their reads say nothing of the queue.
6. **The sessions file** is made (below).
7. **The limit is decided** (below). With the default of 120 a minute, the run stops at about one visit a second.
8. **The edge does not count the runner.** The edge's rate rule refuses an address past 2,000 requests in five minutes (ADR-067), which a run passes within its first minutes. So the runner's IPv4 address goes into the rule's allow list for the run's hour, and the run goes over IPv4:

   ```sh
   set=kuutti-staging-edge-unlimited
   id=$(aws wafv2 list-ip-sets --scope CLOUDFRONT --region us-east-1 --query "IPSets[?Name=='$set'].Id" --output text)
   token=$(aws wafv2 get-ip-set --scope CLOUDFRONT --region us-east-1 --name "$set" --id "$id" --query LockToken --output text)
   aws wafv2 update-ip-set --scope CLOUDFRONT --region us-east-1 --name "$set" --id "$id" --lock-token "$token" \
     --addresses "$(curl -s -4 https://checkip.amazonaws.com)/32"
   # Empties the set when this shell exits, however the run ends.
   trap 'aws wafv2 update-ip-set --scope CLOUDFRONT --region us-east-1 --name "$set" --id "$id" --addresses "[]" \
     --lock-token "$(aws wafv2 get-ip-set --scope CLOUDFRONT --region us-east-1 --name "$set" --id "$id" --query LockToken --output text)"' EXIT
   export NODE_OPTIONS=--dns-result-order=ipv4first   # then run pnpm load:smoke in this shell
   ```

   The address stays out of the repository: OpenTofu leaves the set's contents alone. It is not secret for the hour, though. A pull request's plan reads the set, and CloudTrail's event history keeps the update for 90 days (ADR-067 §5). Merges that touch `infra/` wait for the hour, since an apply would write the address into the state. A minute after the update, the run's requests no longer count at the edge.

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
2. The last request, `/auth/callback`, answers 302 to `fi.kumpa://auth?code=…`, which the browser cannot follow. Copy the code, 43 characters, from its `Location`.
3. Exchange the code **within sixty seconds of the callback**. After that, the exchange answers `auth_code_used`, and the sign-in starts again from the top:

```sh
read -r code                              # paste the code
curl -sS -A kuutti-load-smoke "$api/auth/exchange" -H 'content-type: application/json' \
  -d "{\"code\":\"$code\",\"verifier\":\"$verifier\"}" \
  | node -e 'const a = JSON.parse(require("fs").readFileSync(0, "utf8")); if (!a.refreshToken) { console.error(a.error?.code ?? "no session"); process.exit(1); } console.log(a.refreshToken)' >> "$file"
```

On staging eight of the test persons sign in (`docs/vendors/telia.md` 1.4): Sanna, Noa, Onni and Aino at Nordea's demo (`DEMOUSER4`, `DEMOUSER3`, `DEMOUSER1`, `DEMOUSER2`), Kerttu at Säästöpankki, Tapio at OP and Ilona at Aktia (their codes are in the same section), and Helmi at Telia's Mobiilivarmenne emulator (`0401234567`, prefilled), which sends itself on after ten seconds. After the bank, Telia's bed asks to pass the person's data on: VAHVISTA. Of the eight, all but Helmi have complete profiles since #560 (she has no photos), so theirs are the reads that walk the pool. While a store's review runs, Sanna and Onni are the reviewers' (`docs/runbooks/store-review.md`): leave them out of the file. The nightly demo reset erases the personas, and their sessions with them (ADR-018 §8), so a file made on staging lives until the next reset: sign the test persons in on the day of the run, after that day's reset has run. Its schedule says 02:17 Helsinki time, and GitHub has started it hours later.

Repeat this for each test person with a live account, and for most of them more than once. More sessions add no budget: a person's budget is the account's, and all of its sessions share it. But every signed-in request writes its own session's row (`last_used_at`), and five thousand people write five thousand rows. Seven sessions would put all of the run's writes on seven rows. The script goes round an account's sessions, so two to four each spread that write at no cost to the budget. Each sign-in spends one start of the doors' sixty a minute (ADR-026 §4) and adds a `kuutti-load-smoke` device to that person's sessions.

**How the script uses the file:**

- At its start it rotates every token and writes the new one back before it asks for the next, so the file serves the next milestone too: a session lasts while the smoke runs at least every ninety days, and a year after its sign-in at most (ADR-058). A session the API refuses is commented out with the day, not deleted, and the script says which line.
- Before it asks anybody anything, it refuses:
  - a file without its `# target` line, or one naming another API than `--target`. An API answers another's token the same as an ended one (`session_revoked`), so without the check, a file pointed at the wrong API would lose every session;
  - a file inside any git work tree, this checkout's or another's;
  - a file others can read, a line that is not a refresh token, and two tokens of one session, the same one twice among them (any earlier token of a session presented again ends it, ADR-059).
- It never prints a token, an account or a photo id.

A file written before #490's deploy holds refresh tokens of the old shape, 43 characters with no dot, and the script refuses its first one as not a refresh token before it asks anybody anything. Those sessions are gone anyway, since the deploy deleted every session (ADR-059): delete the file and sign the test persons in again as above.

Never put a phone's session in the file: rotating it would sign the phone out at its next refresh (reuse, #35). The file holds bearer tokens for test persons; delete it when a milestone's runs are done unless it is to be kept.

## The limit

The script plans each stage against the budgets the API reports in `RateLimit-Limit`, taking at most 40 % of each window, and refuses a plan that would take more. The other 10 % up to half is for the sessions' opening requests and a persona's own phone, so a stage planned to the full ceiling does not trip the rest at half (below). The refusal names the most visits a second the sessions allow, and the `rate-limit-per-minute` a plan needs. With six accounts and the default 120 a minute, that is about 0.9 visits a second for the recipe below, and 0.37 for a short stage whose every visit has the photos screen and the queue. Each socket's upgrade counts on the address too, and is never given back (below): with the recipe's 24 sockets, the default allows about 0.53.

To find where the box bends, the maintainer raises `/kuutti/staging/rate-limit-per-minute` for the hour. ADR-026 §5 makes the number his; it is read at boot, so a restart of the API applies it, and the value goes back, with another restart, after the run. The one number is both the address's limit and each person's, so for that hour staging's public routes are less protected. That is why a run is announced and short.

## The run

```sh
pnpm load:smoke -- --target https://api.staging.kuutti.app --confirm-staging \
  --sessions ~/.kuutti-load-sessions-staging --rates 1,2,4,6,8 --stage 60 --sockets 24
```

The recipe's 24 sockets are four for each of the six accounts, the most the script opens.

| option | what it does | default | at most |
|---|---|---|---|
| `--target` | the API: `http://localhost:3000` (or `127.0.0.1`, `[::1]`), or `https://api.staging.kuutti.app` | required | |
| `--confirm-staging` | required for staging, refused anywhere else | | |
| `--sessions` | the sessions file; without it, the public part of each visit alone | none | 50 sessions |
| `--rates` | visits a second, one stage each | `0.5` | 8 stages, 50 a second each |
| `--stage` | seconds per stage | 60 | 300, and 600 for the whole run (an access token lives fifteen minutes and is refreshed once, at the start) |
| `--sockets` | the chat's sockets (`GET /ws`, #349) held idle through the run: opened round the accounts and their sessions, `--concurrency` at a time, before the first stage; each signs in with its first frame, resumes no conversation and answers every ping. Needs `--sessions` | none | 200, and 4 per account |
| `--concurrency` | requests in flight | 16 | 64 |
| `--stop-p95` | the p95 in ms past which a stage has bent | 1000 | 10,000 |
| `--self-test` | the command line, the refusals, the sums, and runs against a stand-in on this computer of every guard below (CI's lint job) | | |

What it refuses before any load:

- Production, by name (`api.kuutti.app`), and any other host but these two.
- `APP_ENV=production` in its own environment, and an `APP_ENV` that disagrees with the target.
- A sessions file it must not take (above).
- `--sockets` without `--sessions`, and more sockets than four for each account the sessions are of. The API holds five an account and closes the oldest for a sixth (`too_many_sockets`), which must never be a persona's own phone.
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
| the address: every request until a guard admits it, given back once the person's limiter counts it (§1, §2) | `rate-limit-per-minute`, 120. The address is the viewer's, behind CloudFront only with the proof of Kuutti's distribution (ADR-066); a run from one laptop is one address | the public requests (nobody's exchange, the run's one read of the counter for its budget, one refresh per session at the start), the signed-in requests in flight, which hold the address's count until answered, and one upgrade per socket (`GET /ws`), at the start, never given back: a socket signs in by its first frame, so no guard admits it. Planned to 40 % of the window, with `--concurrency` and the sockets counted in full |
| each person: every request a guard admits, per account across its sessions (§1, §3) | the same number | visits go round the accounts, planned to 40 % of each account's window, so a persona's own phone keeps more than half |
| the chat's sockets per account, `WS_SOCKETS_PER_ACCOUNT` (#349) | 5, the sixth closing the oldest | at most 4 per account, so a persona's own phone keeps its socket. While they are open the persona shows as online to its matches, as the app would |
| the exposure budget, per account per Finnish day (ADR-008 §1, `photo_fetches_per_day`) | thumb 600, card 0, full 60, and `exposure_cards_per_day` 0, where 0 is off (ADR-062 §9) | thumbnails only, at most 60 per account per run, spread over the run; card and full never. The queue's reads serve cards, which are recorded and meet no ceiling |
| the alarms that shadow-ban a reader (ADR-041, ADR-062 §9) | 30 reads of the queue a minute; 300 different people's cards in 10 minutes | the reads are planned to 40 % of the first, on one visit in Q. The second the run never nears: it decides nothing, so an account is served the same undecided cards all day, at most a page of people. The third, 1,500 card photos in 60 minutes, it never touches |
| the 5xx alarm, `kuutti-staging-api-5xx` | five in five minutes | the run stops sending at its third server error or unanswered request. The requests already in flight, up to `--concurrency`, still finish, and at the bend they tend to fail together (a full pool fails every waiting request). So the alarm may mail at the bend: that is expected, and announced |
| the edge's rate rule (#41, ADR-067) | 2,000 requests from one address in five minutes, a signed photo's path and the two sign-in starts not counted | nothing, once the runner's address is in the allow list (Before a run, step 8). Without it the edge answers 429 `rate_limited` with `"requestId":"edge"` within the run's first minutes, and the run stops there, as at any 429 |

The plan is backed by guards as the run goes:

- An answer with less than half its window left (`RateLimit-Remaining`) rests that budget for a window: the person's on a signed-in route, the address's on a public one. The stage counts what it held back, and a stage that held back more than 1 % of its parts is not measured.
- The first 429 of any kind stops the run with exit 2: `rate_limited`, or `photo_budget_exceeded`, whose alarm counts 100 a day.
- So does the first 401 of a session.
- So does a socket that does not open, or that the server closes during the run. The script names the socket by its number, with the close code and the error frame's code; a refused upgrade, a 429 from the address's limiter among them, shows only as a failed connection (Node's client sees no status). On 10/11/2026 one of the first run's 24 failed so before the API saw it: the log had the other 15 of its batch and no refusal, and the same run again opened all 24. When the log has nothing for the socket, run once more before reading it as the box's.

## While it runs: what to watch

The script measures from outside: its p95 includes the network from the runner to CloudFront. The server's side is in CloudWatch, for the stages' minutes; the script prints each stage's start in UTC. These commands are the maintainer's (`pnpm aws:login` first). `<id>` is `tofu output instance_id` in `infra/envs/staging`.

- **The box's own p95 per route:** the Logs Insights saved query `kuutti-staging/p95-duration-by-route` over the run's window. Its `durationMs` starts when Hono takes the request, so it leaves out the time a request waited for the event loop.
- **The event loop.** The API is one Node process (`CMD ["node", "dist/index.js"]`, no cluster), so its JavaScript runs on one core: JSON and zod, the logger, the URL signatures. On the two-core box, one core flat out shows as about 50 % `CPUUtilization`, not 100 %. When the event loop is what bends, the box sits near 50 %, the database's connections stay under the pool's size, the log's p95 stays flat, and the script's p95 climbs. The gap between the two p95s is the time spent waiting for the loop.
- **Postgres connections:** RDS `DatabaseConnections`. The API's pool is `DB_POOL_MAX` (10 unless set). When the pool is what bends, the connections sit at the pool's size while p95 climbs and the database's CPU does not.
- **The database:** RDS `CPUUtilization` and `CPUCreditBalance`. Staging's database is a db.t4g.micro and production's a db.t4g.small, so staging's ceiling there is a lower bound for production's.
- **The box:** EC2 `CPUUtilization` and `CPUCreditBalance` (a t4g.small, two cores; see the event loop above), and the free memory of #77's metric. EC2 sends staging's every five minutes (basic monitoring), one or two points for a whole run, so read the box from inside as well, every ten seconds through the run: the api container's CPU, where 100 % is one core flat out (the event loop), and each core's busy share. The command below prints both, through Run Command, the way the headroom document reaches the box (`infra/README.md`), with nothing to type on it. It follows the container it finds at its start, so start it after any restart of the API.
- **The sockets:** they open just before the first stage. Each holds some memory on the box, and the API checks its session at every ping, every 30 s, so 24 sockets add about one session read a second to every stage.
- **sharp:** not driven (below).

```sh
from=2026-10-20T18:00:00Z; to=2026-10-20T18:06:00Z     # the first stage's start and the run's end
aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name DatabaseConnections \
  --dimensions Name=DBInstanceIdentifier,Value=kuutti-staging --statistics Maximum \
  --period 60 --start-time "$from" --end-time "$to"
```

The same command with `--metric-name CPUUtilization` and `CPUCreditBalance` covers the database. With `--namespace AWS/EC2 --dimensions Name=InstanceId,Value=<id>` it covers the box, five minutes a point.

The box from inside, started just before the run and read after it (`<id>` as above; 600 seconds covers the recipe):

```sh
cat > /tmp/box.sh <<'SH'
ctr=$(docker ps --format '{{.Names}}' | grep -E '^staging-api' | head -1)
cpu() { awk '/^cpu[0-9]/ { t = 0; for (i = 2; i <= 9; i++) t += $i; print $1, $5 + $6, t }' /proc/stat; }
prev=$(cpu); end=$(($(date +%s) + 600))
while [ "$(date +%s)" -lt "$end" ]; do
  sleep 8; api=$(docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' "$ctr"); now=$(cpu)
  cores=$(paste -d' ' <(echo "$prev") <(echo "$now") | awk '{ printf "%s %d%% ", $1, 100 * (($6 - $3) - ($5 - $2)) / ($6 - $3) }')
  prev=$now; echo "$(date -u +%H:%M:%S) api $api | $cores"
done
SH
cid=$(aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript \
  --parameters "{\"commands\":[\"echo $(base64 < /tmp/box.sh | tr -d '\n') | base64 -d | bash\"],\"executionTimeout\":[\"720\"]}" \
  --query Command.CommandId --output text)
# after the run:
aws ssm get-command-invocation --command-id "$cid" --instance-id <id> --query StandardOutputContent --output text
```

## After the run

1. Put the script's row in the table. Fill the milestone, the log's p95 at the bend, what bent first, and the three server columns.
2. Set `rate-limit-per-minute` back and restart, if it was raised. On staging the parameter did not exist before the first run (the 120 is the code's default), so going back was `aws ssm delete-parameter --name /kuutti/staging/rate-limit-per-minute`. A restart is `sudo docker service update --force <the api service>` on the box (`incident.md` names the service), some twelve seconds on 10/11/2026.
3. The edge's allow list is empty again: the `trap` of Before a run, step 8, emptied it when its shell exited. `aws wafv2 get-ip-set --scope CLOUDFRONT --region us-east-1 --name kuutti-staging-edge-unlimited --id "$id" --query 'IPSet.Addresses'` says `[]`; if not, run the trap's command by hand.
4. If `kuutti-staging-api-5xx` mailed, check in `kuutti-staging/errors-by-route` that its 5xx fall in the run's last stage, and say so to the team.
5. If the first thing to bend is a surprise, open an issue for it.

## The table

One row per milestone run. "held" is the last stage that held, and "bent" the first that did not, or the stage that was not measured, with why. A stage's cell is its visits a second, the requests answered a second, and the p95 in ms, all the script's; any parts held back or timeouts follow in brackets. "grid" is the photos screen's share: one visit in N, and the signed URLs a visit. "sockets" is how many of the chat's sockets were open at the end of the run, of how many it held, or `-` for a run without `--sockets`; a socket lost stops the run without a row, so in a row the two agree. They are idle, at most four an account, so the count is a lower bound: the box held at least that many while it served the rate, where five thousand people with the app open would hold thousands. The limit is `rate-limit-per-minute` during the run.

| date | milestone | version | target | accounts · sessions · limit | grid: 1 in N · URLs a visit | sockets: open of held | held: visits/s · req/s · p95 ms | bent: visits/s · req/s · p95 ms (why) | log p95 ms at the bend | first to bend | DB connections, max | box CPU % · free MB | DB CPU % · credits |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-10 | R1 Tech hygiene | 0.118.3-11a0210 (11a0210) | staging | 6 · 7 · 3000 | 1 in 21 · 0.29 | 24 of 24 | 8 · 44.1 · 100 | - (did not bend up to 8) | - | nothing; the DB pool at its 10 from 4 | 10 | api 13–28 % of a core at 6–8 (EC2 17 %, five minutes) · 424 | 11.6 · 288 |
| 2026-11-10 | R1 Tech hygiene | 0.118.3-11a0210 (11a0210) | staging | 6 · 7 · 3000 | 1 in 48 · 0.13 | 24 of 24 | 20 · 107.4 · 69 | - (did not bend up to 20, the script's cap) | - | nothing; the api at 63 % of a core at 20 | 10 | api 38–63 % of a core at 20 (EC2 32 %, five minutes) · 432 | 18 · 288 |
| 2026-11-10 | R1 Tech hygiene | 0.118.3-11a0210 (11a0210) | staging | 6 · 7 · 6500 | not recorded | 24 of 24 | 50 · 261.4 · 228 (27 of 3,000 visits dropped) | - (held at 50, the cap of #652's script; the bend lies just past it) | 109, then 256, at 50 | the API's one core, full at 50 (the event loop) | 10 | api 86–109 % of a core at 50 (EC2 54–59 %, five minutes) · 412 | 41 · 285 |

## Past the one core

The first run found the API's one core the first to give, at nine times the bad hour. When that margin is spent, the obvious lift is a second API process, by Node's cluster or a second container. It is not free: the API keeps some of its guards in the memory of its one process, and a second process halves each of them, with nothing to say so.

- **The request limits.** The address's, each person's and the sign-in doors' budgets are fixed windows in the process (`apps/api/src/lib/rate-limit.ts`, TD-3, ADR-026 §1 and §4). Two processes give every address and every person twice the budget, and every address twice the doors' starts.
- **The velocity rule on the queue.** Its count of an account's reads lives in the process (`queue_reads` in `apps/api/src/safety/automatic.ts`, ADR-041 §3), so two processes split it, and a scraper takes twice the reads before the shadow ban. The photo rules count the fetch log in the database and are not split; neither is the exposure budget, nor anything else the database holds.
- **The chat's presence.** The open sockets are a map in the process (`apps/api/src/chat/presence.ts`, ADR-031 §9). Each process would know only its own: an account could hold five sockets on each, the online mark would show only for sockets on the same process, and a push would no longer be spared for somebody whose app is open on the other one (#102). The message push's spacing is in the process too (`message_push_min_interval_minutes`, `apps/api/src/notifications/push.ts`), so a conversation could push once from each. Delivery itself would work, since LISTEN/NOTIFY reaches every process that listens.
- **The night's jobs.** They run on one timer in the process (`apps/api/src/jobs/nightly.ts`), with no lock: only the migrations take an advisory lock (`boot.ts`). Two processes would run every job twice.

A restart or a deploy already empties the first three, so their loss is the same as on every deploy, only for good. Before a second process, then: the limits and the queue's count where both processes see them (a table in Postgres, not a new service, TD-3), presence the same way or the chat's sockets pinned to one process, and the night's jobs under an advisory lock. Nothing of that is needed while the ceiling stands at nine times the bad hour; it becomes needed when a run's held column comes within twice the bad hour's 5.6 visits a second, or the bad hour itself is raised (#689).

## What the run leaves out, and what would make it needed

- **The sign-in's start and the bank's callback.** A start writes an `auth_request` row and has a request object signed, and the doors let one address start sixty a minute. The callback is the bank's. This would be needed for a launch's sign-up wave: then a measure of the start alone, within the doors, apart from this run.
- **The refresh.** The app refreshes its access token when it has under thirty seconds of its fifteen minutes left, so in the bad hour nearly every opening sends `POST /auth/refresh` too. That is a public request, counted in full on the address, and an update that rewrites two uniquely indexed hashes of the session's row. The run refreshes each session once, at its start, and never mid-run: a rotation whose answer is lost, as at a bend, would leave the file with a retired token, and presenting that one ends the session (#35), which costs a sign-in at the bank. So the measured ceiling is optimistic by about one write a visit. This would be needed if the database is what bends first: then a refresh stage with sessions made for it alone.
- **Uploads, sharp's concurrency.** The pool re-encodes `IMAGE_CONCURRENCY` pictures at once (the core count, two on staging's box) and refuses the next with 503 `media_busy` rather than queue it. So its ceiling is known by construction, and the time a picture takes is `POST /photos`'s `durationMs` in the log. A driven upload would add photos to the test persons, cost three Rekognition calls each on staging (two when the scene call fails), and count its refusals toward the 5xx alarm. This would be needed before a launch, when people onboarding upload three to six pictures each: then an upload stage with the alarm in mind.
- **Writes** to the profile, the preferences or the consents. They would change the test persons' answers, which the demo shows. The queue's read does write: an account's first read of a Finnish day opens its log and adds the first people, and every card served goes on the shown record. An entry nobody displayed is deleted by that person's next day's first read; the shown record stays, as any card's does.
- **The walk of the pool, under load.** A run reads the queue and never decides, since a decision would write the test persons' days, which the demo shows. So an account with cards left walks the pool once, at its first read of the Finnish day, and reads the cheap shape from then on; one at its queue's end walks on every read; and which it was shows in the route's p95, not in the row. The walk's size is staging's too: it reads everybody the one pond holds, so it reads what `demo-population` wrote, but it orders only the complete, and a population without faces has none of those. This would be needed before a launch, when people go through the queue at length: then a stage whose reads decide, by test persons made for it, against a population of its full size with faces.
- **The chat's traffic.** The chat's sockets are held idle, at most four an account, so their count is a lower bound of what the box holds (above). No message is sent, read or pushed through them: sending would write the test persons' conversations, which the demo shows. This would be needed once people use the chat more than the profile: then a stage that sends and reads messages between test persons made for it, and sockets for many more of them.
- **Many addresses.** The run comes from one, so the address limit it meets is the runner's, not five thousand people's.
- **Many people.** The run is a handful of accounts and sessions. Their rows are hot: every signed-in request updates its session's row, and the URL route locks per account, so a few rows take all the writes and queue on each other as latency rises. Their data is a few pages the database keeps cached. Five thousand people spread the writes over five thousand rows and need a working set that may not fit. Where the run bends is then neither their best case nor their worst. More sessions per person (above) spread the session writes. The synthetic population (`demo:population`) makes the tables population-sized, but none of its people can sign in (no bank login maps to them), so the driven reads stay on the test persons' rows. On 10/11/2026 staging held 106 complete people, about a fiftieth of the claim, so the first run's walks were small ones. This would be needed if the run's ceiling comes close to the claim: then sessions for many more test persons.
