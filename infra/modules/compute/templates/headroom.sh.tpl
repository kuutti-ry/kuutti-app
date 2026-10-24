# Headroom on the API box (#77, ADR-046): swap, the free memory pushed every
# minute for the memory-low alarm (modules/observability), and a memory limit
# on Dokploy's own service. user_data runs this at first boot, after the
# installer; a running box gets the same text from the Run Command document
# of main.tf, which the maintainer sends. A second run changes nothing. POSIX
# sh: the Run Command agent runs it with dash. The two steps that can fail,
# the first push and Dokploy's update, never stop the other: each is said,
# and the run ends with a failure for either.
set -eu
export PATH="$PATH:/snap/bin"
rc=0

# --- Swap ------------------------------------------------------------------
# On 2026-09-27 and 2026-10-08 the box (1.8 GB, no swap) ran out of memory:
# the OOM killer took Dokploy every two minutes, and every kill had Swarm
# restart every service, the API's included. Swap turns that into a slow
# minute. swap_mb is the environment's: production has none until ADR-046's
# open point on rule 1 is answered, and 0 leaves whatever is there alone.
if [ ${swap_mb} -gt 0 ]; then
  if [ ! -f /swapfile ]; then
    fallocate -l ${swap_mb}M /swapfile
    chmod 0600 /swapfile
    mkswap /swapfile
  fi
  # A swap file made by hand (staging's, since 2026-10-08) keeps its size but
  # not a mode that lets anyone else read the pages in it.
  chown root:root /swapfile
  chmod 0600 /swapfile
  swapon --noheadings --show=NAME | grep -qx /swapfile || swapon /swapfile
  grep -q '^/swapfile[[:space:]]' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Swap for what has to give way, not for whatever is merely idle.
  echo 'vm.swappiness = 10' > /etc/sysctl.d/90-kuutti-swap.conf
  sysctl -q -w vm.swappiness=10
  echo "swap: $(swapon --noheadings --show=NAME,SIZE | tr '\n' ' ')"
else
  echo "swap: none set here (swap_mb is 0)"
fi

# --- Free memory, every minute ---------------------------------------------
# What the memory-low alarm reads: MemAvailable, the kernel's estimate of what
# can be had without swapping, in MiB (CloudWatch's unit is named Megabytes).
# A cron line and the AWS CLI rather than the CloudWatch agent (#77: the
# cheapest signal); the instance role may put metrics in ${namespace} and
# nowhere else. flock keeps one push alive at a time, and the CLI's
# timeouts end a stuck one within a minute. The log holds the last run's
# error, empty after a good one.
cat > /usr/local/bin/kuutti-memory-metric <<'SH'
#!/bin/sh
set -eu
mb=$(awk '/^MemAvailable:/ { printf "%d", $2 / 1024 }' /proc/meminfo)
aws cloudwatch put-metric-data --region ${region} --namespace '${namespace}' \
  --metric-name MemAvailable --unit Megabytes --value "$mb" \
  --cli-connect-timeout 5 --cli-read-timeout 10
SH
chmod 0755 /usr/local/bin/kuutti-memory-metric
cat > /etc/cron.d/kuutti-memory-metric <<'CRON'
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
* * * * * root flock -n /run/kuutti-memory-metric.lock /usr/local/bin/kuutti-memory-metric >/dev/null 2>/var/log/kuutti-memory-metric.log
CRON
if /usr/local/bin/kuutti-memory-metric; then
  echo "memory: MemAvailable to ${namespace} every minute"
else
  echo "WARNING: the first push of MemAvailable failed; cron tries again every minute" >&2
  rc=1
fi

# --- Dokploy's limit ---------------------------------------------------------
# Dokploy idles at about 0.8 GB. A limit on its service (the dokploy service
# alone) keeps a Dokploy that grows inside its own cgroup, so the kernel or
# Node takes Dokploy alone and Swarm starts it again, while the API, Traefik
# and the previews keep their memory. Node inside reads the limit and sizes
# its heap at half of it, so a growing heap ends in Node's own abort; what
# grows outside the heap pages into the container's share of swap (Docker's
# default for a limited container is as much again) and then meets the OOM
# killer. The installer's update changes the image alone (`docker service
# update --image`), so the limit stays. Setting it restarts Dokploy's task
# once (stop-first), never the API's. jq rather than a --format template: a
# Run Command document reads double braces as its own parameters.
if docker service inspect dokploy >/dev/null 2>&1; then
  want=$((${dokploy_memory_mb} * 1048576))
  have=$(docker service inspect dokploy | jq -r '.[0].Spec.TaskTemplate.Resources.Limits.MemoryBytes // empty')
  if [ "$have" = "$want" ] || docker service update --limit-memory ${dokploy_memory_mb}M dokploy; then
    echo "dokploy: memory limit ${dokploy_memory_mb} MiB"
  else
    echo "WARNING: Dokploy's memory limit is not set" >&2
    rc=1
  fi
else
  echo "WARNING: no dokploy service, so no memory limit on it" >&2
fi
exit $rc
