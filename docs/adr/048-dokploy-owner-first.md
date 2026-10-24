# ADR-048: Nothing public reaches Dokploy before it has its owner

- Status: proposed (#437, built as written here and verified at production's first boot on 2026-10-24, #25: the two checks of `infra/README.md`, After the first apply, step 2, answered 404; accepting it is the maintainer's)
- Date: 2026-10-24
- Follows: ADR-001 (`user_data` installs Dokploy, whose configuration is the one manual island, and a change to user data never reaches a running box), ADR-005 §7 (the box admits 80 and 443 from anywhere until the ingress switch), TD-19 (one staging box with the previews on it); the control-plane pin of #9 (`infra/README.md`, Previews, Trust); issues #437, #25

## Context

Dokploy makes its owner at the first sign-up. On a self-hosted install, a sign-up without an invitation succeeds while no member has the role `owner`, and that user becomes it (`packages/server/src/lib/auth.ts` at the tag `v0.30.6`, the user-creation hooks). The owner holds Docker on the box, so root, and through it the instance role and the parameters of `/kuutti/<env>/*` the role reads. Until the maintainer has made the account through the Session Manager port forward, whoever opens the UI first is the owner.

Two routes led from the public ports to the UI in that window:

1. **Dokploy's own.** At its first start Dokploy writes `/etc/dokploy/traefik/dynamic/dokploy.yml` with a router from ``Host(`dokploy.docker.localhost`)`` on port 80 to its UI, unless the file exists (`createDefaultServerTraefikConfig`, `packages/server/src/setup/traefik-setup.ts`). Assigning Dokploy's domain replaces that router (`updateServerTraefik`, `packages/server/src/utils/traefik/web-server.ts`), which `dokploy-setup.sh` does once the owner's API key exists.
2. **Ours.** User data wrote `00-control-plane.yml`, priority routers for `dokploy.<environment>.<domain>` on 80 and 443, so that a preview's member token could not take the control plane's host (#9). On staging that name resolves and gets a certificate. On production it was `dokploy.prod.kuutti.app`, which has no record: `envs/prod/dns.tf` and `dokploy-setup.sh` use `dokploy.kuutti.app`.

No box was open when this was found: staging's Dokploy has had its owner since September, and production has never been applied. Production's first boot, and any rebuild with `-replace`, would have opened the window for the minutes or hours until the maintainer signed in.

## Decision

1. **First boot writes Dokploy's `dokploy.yml` itself, with the service alone**, before the installer starts Dokploy: `dokploy-service-app`, `http://dokploy:3000` with `passHostHeader`, as Dokploy writes it. Dokploy then adds no default router. Assigning its domain adds the router to this file, since `updateServerTraefik` creates one when none is there.
2. **First boot writes no control-plane router.** Nothing on 80 or 443 reaches Dokploy until `dokploy-setup.sh` has run, and it runs on the owner's API key; before that, the port forward to 3000 is the only way in. The pin keeps `dokploy` and `api` from a member token, and before setup no previews project and no member exist.
3. **`dokploy-setup.sh` is the pin's one writer, and fails closed.** Before it changes anything it requires `INSTANCE_ID` and checks that box's `Name` tag against the environment: staging and production share the account, so Run Command would take either box's id, and the call also proves the AWS session. The command on the box runs under `set -e`, since Run Command reports the last command's status, and the script stops before the deployment unless Run Command reports success. The pin carries its own service for Dokploy, as it does for the API, so it holds when Dokploy rewrites or removes its `dokploy.yml` (clearing the domain removes it). Until now a run without `INSTANCE_ID` warned and went on, while first boot's pin covered the `dokploy` host.
4. **A check a person can run.** `infra/README.md` (After the first apply, step 2) gives two `curl` calls to the Elastic IP with the two host names, which a fresh box answers with Traefik's 404, or not at all while Traefik is still starting. The security checklist carries the line, to be ticked at production's first boot.
5. **A rebuild starts Dokploy only with its owner.** The backup brings `/etc/dokploy` back, routers included, before Dokploy's database, so the restore in `infra/README.md` (Backups and rebuilding the box, step 3) stops on the first failed statement and counts the owner before it scales Dokploy up.

## Consequences

- A fresh box serves nothing of Dokploy's in public until it has its owner, and production's control-plane host is no longer misnamed, since first boot names none.
- A rebuild stays in the same steps, with the restore checked as in point 5.
- Running boxes are untouched (`ignore_changes`, ADR-001); staging's pin is the one `dokploy-setup.sh` wrote.
- The template no longer takes `environment` and `domain`. User data is about 13.7 KB, of the 16,384 bytes EC2 takes.
- A bump of `dokploy_version` checks the two points of Dokploy's code this rests on: no default router when `dokploy.yml` exists, and a router added when the domain is assigned to a file with none (the variable's description says so). A version that changed the first would bring the route back; one that changed the second would leave Dokploy's domain unrouted, and setup's pin would still route it.

## Not done, and what would make it needed

- **Closing 80 and 443 in the security group until setup.** It would take an apply in the middle of the setup, which CI runs for production only on a tag. Worth it if something other than Traefik ever listens there before setup.
- **A test of user data.** There is no harness for it. The render, `bash -n` and the YAML were checked by hand in #437; the two `curl` calls are the test on a box.

## Alternatives considered

- **Removing Dokploy's router after the installer:** a race with Dokploy's start. Writing the file before Dokploy starts is deterministic.
- **Naming production's host right in first boot's pin:** it would have given the unclaimed Dokploy a real name and a certificate from first boot.
- **Keeping first boot's pin behind an allow-list that admits nobody:** a pin that guards nothing before a member exists, and one more file to keep in step with setup's.
