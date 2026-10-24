# ADR-046: Headroom on the one box: swap, a limit on Dokploy, its free memory watched

- Status: proposed (#77, built as written here; the sizes come from the two outages' figures, not from a measurement on the box since; sending the document to the running staging box and #77's three checks are the maintainer's, `infra/README.md`, The box's headroom; swap in production waits for his answer under "Open, the maintainer's")
- Date: 2026-10-24
- Follows: TD-19 (one staging box with the previews on it), TD-2 (three previews), TD-4 (one vendor, AWS), ADR-001 (`user_data` installs Dokploy and never reaches a running box), ADR-012 (whose Consequences left this open), ADR-018 (staging's people are Telia's test persons), CLAUDE.md rule 1 (the hetu is never persisted), rules/infra.md (the alarms CloudWatch carries), the maintainer's word that staging stays a t4g.small (2026-09-19); issues #77, #200, #191, #25; the outages of 2026-09-27 and 2026-10-08

## Context

The staging box is a t4g.small: two burstable cores and 1.8 GB, with no swap from its first boot. It carries Dokploy (about 0.8 GB idle on arm64 at v0.30.6, beside its Postgres), Traefik, the staging API and up to three previews (`PREVIEW_LIMIT` in `preview.yml`). On 2026-09-27 three previews of merged pull requests were still on it, and Dokploy took 0.8 to 1 GB; on 2026-10-08 two merges and a preview deploy came at once, six API containers ran, and Dokploy's main process held 0.5 to 0.9 GB each time the OOM killer took it. Both times the killer took Dokploy every few minutes, each kill broke the Swarm agent's heartbeat, the manager restarted every service, and the API was unreachable for most of an hour. EC2's status check saw a healthy instance throughout, and nothing measured memory (`docs/runbooks/incident.md`, the worked example). The second time a 2 GB swap file made by hand ended the loop. A rebuilt box would not have it, and an edit of user data never reaches a running box (`ignore_changes`, ADR-001).

## Decision

1. **Swap, per environment** (`swap_mb` of `modules/compute`): a file `/swapfile` in `/etc/fstab`, mode 0600 whoever made it, with `vm.swappiness = 10`, which keeps what is idle in memory and leaves the swap for what has to give way. Staging takes 2 GB, the size that held on 2026-10-08 (433 MB in use afterwards); gp3 takes the paging. Production takes none for now: swap can page the API's memory to the root volume, a hetu in flight during a callback and the HMAC key included, and whether that counts as persisting under rule 1 is the maintainer's to answer (below). Staging's people are Telia's test persons (ADR-018), so no real hetu is paged there. `swap_mb = 0` leaves whatever a box has alone.
2. **A memory limit on Dokploy's own service, 1024 MiB** (`dokploy_memory_mb`): the `dokploy` service alone, not its Postgres or Traefik. It is above what Dokploy idles at and at about what it took on 2026-09-27, so it does not hold a normal Dokploy; it holds one that keeps growing, inside its own cgroup, while the API, Traefik and the previews keep their memory, and no OOM storm reaches the Swarm agent. Node inside Dokploy reads the limit and sizes its heap at half of it (512 MiB), so a growing heap ends in Node's own abort; what grows outside the heap pages into the container's share of swap (Docker's default for a limited container is as much again) and then meets the OOM killer. Either way Swarm starts Dokploy again, alone. `docker service update --limit-memory` sets it and restarts Dokploy's task once; the installer's `update` changes the image alone, so the limit outlives an upgrade. No limit on the API: that would make the API the first to go, the wrong way round.
3. **The box's free memory, once a minute, in a namespace of its own.** A cron line runs the AWS CLI to put `MemAvailable`, in MiB, into `Kuutti/<env>/box`; the instance role may put metrics there and nowhere else (`cloudwatch:namespace`). Not `Kuutti/<env>`: there the log filters write `Api5xx`, `NightlyFailures` and `PhotoBudgetRefusals`, and anything on the box (the API, a preview) could push negative values into them and keep their alarms quiet. `flock` keeps one push alive at a time and the CLI's timeouts end a stuck one, so a slow push never piles up on a box short of memory. Not the CloudWatch agent: a resident process, with a configuration of its own, for one number.
4. **An alarm under 200 MB for five minutes,** `kuutti-<env>-memory-low`, to the alert topic (`modules/observability`, `memory_available_mb`). Missing data counts as breaching once no real datapoint is left in the range CloudWatch evaluates: a box that never ran the script is in ALARM within a minute or two, one that stops pushing a few minutes after its last good datapoint, and a single missed push between good ones counts for nothing.
5. **One script, two ways onto a box.** `modules/compute/templates/headroom.sh.tpl` is POSIX sh and idempotent: a swap file made by hand keeps its size, a limit already set is left alone, and a second run changes nothing. The metric goes in before the Dokploy step, and a failed first push and a failed Dokploy update each leave the other step done and fail the run. User data runs it at first boot, after the installer, since the limit needs Dokploy's service. The Run Command document `kuutti-<env>-headroom` carries the same text to a running box; the maintainer sends it, never CI. A plan fails when the script holds a double brace, which Run Command reads as a parameter.
6. **The runbooks.** `alerts.md` gains the alarm's row and puts memory first in `api-unreachable`'s; the restore drill of `incident.md` no longer adds swap by hand; the first prerequisite of `capacity.md` is this alarm in OK.

## Consequences

- Cost: one custom metric (0.30 USD), one alarm (0.10 USD) and about 44,000 `PutMetricData` calls a month (0.44 USD at list price), under 1 USD a month per environment. On the box, the CLI's start costs under a CPU second a minute (not measured on the box), under one of the 24 credits a t4g.small earns an hour.
- The apply that brings this, on the merge, puts the staging alarm in ALARM within a minute or two, since the running box pushes nothing yet; it returns to OK once the maintainer has sent the document. A rebuilt box does the same until first boot has run the script.
- Sending the document restarts Dokploy's task, its UI away for a minute, and nothing else.
- User data is 14,814 of the 16,384 bytes EC2 takes; the AWS provider refuses more at plan, `ignore_changes` notwithstanding.

## Open, the maintainer's

- **Swap in production and rule 1.** Swap can write a page holding a hetu, during the callback or left in a freed heap, or the HMAC key, to `/swapfile`, where it stays after the process has let go of it and across a reboot. The root volume is encrypted, deleted with the instance and never snapshotted, and whoever can read the file is root on the box and can read the key from SSM anyway. The choices before production's first boot (#25): accept plain swap and say so here; swap encrypted with a key made at each boot (`/etc/crypttab`, so nothing in it is readable after a reboot); or no swap in production, where no previews run. Until then `envs/prod` sets `swap_mb = 0`.
- **The limit's size.** 1024 MiB is the issue's figures, not a measurement: Dokploy's own usage in `docker stats` before the document is sent, and `docker service ps dokploy` after it, say whether it holds an idle Dokploy (`infra/README.md`, The box's headroom).

## Not done, and what would make it needed

- **`PREVIEW_LIMIT` 2, or a t4g.medium** (#77's comment of 2026-10-08). Staging stays a t4g.small, and TD-2 names three previews. If the alarm fires with three previews and nothing else wrong, one of the two is the next step, the maintainer's to choose.
- **A memory limit on each preview**, set by `preview.yml` through Dokploy's application settings: it would keep a preview from taking the staging API's memory. Worth it once the alarm shows the previews as the cause.
- **An automatic action on the alarm.** It mails, and its row says what to scale down.

## Alternatives considered

- **The CloudWatch agent** (point 3).
- **systemd-oomd or earlyoom:** they choose a victim by pressure, which on this box could be the API.
- **zram instead of a swap file:** more CPU on two burstable cores, and a second mechanism where one has already held.
