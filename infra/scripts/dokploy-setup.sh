#!/usr/bin/env bash
# Configures an environment's API application in Dokploy through its API, so
# the only clicks left are the ones that create credentials (the admin
# account, its 2FA and the API key). Idempotent: run it again after a change
# and it updates what exists.
#
#   read -rs DOKPLOY_TOKEN && export DOKPLOY_TOKEN    # the API key, never on a command line
#   DOKPLOY_URL=http://localhost:3000 INSTANCE_ID=<i-…> infra/scripts/dokploy-setup.sh staging
#
# INSTANCE_ID (tofu output instance_id in infra/envs/<env>) is required: the
# script writes the Traefik control-plane routers on the box through Run
# Command, and nothing else writes them, since first boot routes nothing to
# Dokploy before it has its owner (ADR-048).
# DOKPLOY_URL is the port-forward while Dokploy has no domain of its own, the
# real https://dokploy.<env>.<domain> afterwards. The token comes from Profile
# in the UI and is exported in your shell; this script never prints it.
# Everything it sets is what infra/README.md "After the first apply" lists:
# project <env>, application api from the GHCR image, the three environment
# lines, the api.<env> domain with Let's Encrypt, Dokploy's own domain, on
# staging the previews' one certificate (ADR-053), and one deployment. The
# container's log driver is the Docker daemon default (awslogs, set by
# user_data), not an application setting.
set -euo pipefail

env="${1:?usage: dokploy-setup.sh <staging|prod>}"
: "${DOKPLOY_URL:?export DOKPLOY_URL (http://localhost:3000 through the tunnel)}"
: "${DOKPLOY_TOKEN:?export DOKPLOY_TOKEN (API key from Settings, Profile)}"
: "${INSTANCE_ID:?export INSTANCE_ID (tofu output -raw instance_id in infra/envs/<env>)}"
for tool in curl jq aws; do command -v "$tool" >/dev/null || { echo "$tool is not installed" >&2; exit 1; }; done

case "$env" in
  staging) app_env=staging; api_host=api.staging.kuutti.app; dokploy_host=dokploy.staging.kuutti.app; preview_domain=preview.api.staging.kuutti.app ;;
  prod)    app_env=production; api_host=api.kuutti.app; dokploy_host=dokploy.kuutti.app; preview_domain= ;;
  *) echo "environment must be staging or prod" >&2; exit 2 ;;
esac
[ -z "$preview_domain" ] || command -v openssl >/dev/null || { echo "openssl is not installed" >&2; exit 1; }

# Staging and production share the account, so Run Command would take either
# box's id; the Name tag (modules/compute) says whose it is. This also proves
# the AWS session before anything in Dokploy changes.
box=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].Tags[?Key==`Name`]|[0].Value' --output text)
[ "$box" = "kuutti-$env" ] || { echo "INSTANCE_ID $INSTANCE_ID is $box, not kuutti-$env" >&2; exit 1; }
image="ghcr.io/kuutti-ry/kuutti-api:main"
url="${DOKPLOY_URL%/}"

api() { curl -fsS --max-time 30 -H "x-api-key: $DOKPLOY_TOKEN" -H 'content-type: application/json' "$@"; }
get() { api "$url/api/$1"; }
post() { api -X POST "$url/api/$1" --data "$2"; }

# --- project -----------------------------------------------------------------
project_id=$(get project.all | jq -r --arg n "$env" '.[] | select(.name == $n) | .projectId' | head -1)
if [ -z "$project_id" ]; then
  # Dokploy v0.30.6 answers { project, environment }; the id is the project's.
  project_id=$(post project.create "$(jq -cn --arg n "$env" '{name: $n, description: "The \($n) environment (infra/envs/\($n))"}')" | jq -r '.project.projectId // empty')
  [ -n "$project_id" ] || { echo "project.create answered without .project.projectId (has Dokploy's answer changed?); the project may exist now, so run again: it is found by name" >&2; exit 1; }
  echo "created project $env ($project_id)"
else
  echo "project $env exists ($project_id)"
fi

# Dokploy gives every project one environment (named production by default);
# applications hang off it.
environment_id=$(get "project.one?projectId=$project_id" | jq -r '(.environments // [])[0].environmentId // empty')
[ -n "$environment_id" ] || { echo "project $env has no environment; open it once in the UI" >&2; exit 1; }

# --- application -----------------------------------------------------------
app_id=$(get "environment.one?environmentId=$environment_id" | jq -r '.applications[] | select(.name == "api") | .applicationId' | head -1)
if [ -z "$app_id" ]; then
  app_id=$(post application.create "$(jq -cn --arg env "$environment_id" \
    '{name: "api", appName: "api", description: "The Kuutti API, deployed by deploy.yml from GHCR", environmentId: $env, sourceType: "docker"}')" | jq -r '.applicationId // empty')
  [ -n "$app_id" ] || { echo "application.create answered without .applicationId (has Dokploy's answer changed?); the application may exist now, so run again: it is found by name" >&2; exit 1; }
  echo "created application api ($app_id)"
else
  echo "application api exists ($app_id)"
fi

# The image is public on GHCR; no registry credential ever lives on the box.
post application.saveDockerProvider "$(jq -cn --arg id "$app_id" --arg image "$image" \
  '{applicationId: $id, dockerImage: $image, username: null, password: null, registryUrl: null}')" >/dev/null
echo "image $image"

# Exactly these three lines: everything else comes from SSM through the
# instance role (rules/infra.md), never from Dokploy.
post application.saveEnvironment "$(jq -cn --arg id "$app_id" --arg env "$(printf 'NODE_ENV=production\nAPP_ENV=%s\nPORT=3000' "$app_env")" \
  '{applicationId: $id, env: $env, buildArgs: "", buildSecrets: "", createEnvFile: false}')" >/dev/null
echo "environment NODE_ENV=production APP_ENV=$app_env PORT=3000"

# --- domain ------------------------------------------------------------------
if get "domain.byApplicationId?applicationId=$app_id" | jq -e --arg h "$api_host" '.[] | select(.host == $h)' >/dev/null; then
  echo "domain $api_host exists"
else
  post domain.create "$(jq -cn --arg id "$app_id" --arg host "$api_host" \
    '{applicationId: $id, host: $host, path: "/", port: 3000, https: true, certificateType: "letsencrypt", domainType: "application"}')" >/dev/null
  echo "domain https://$api_host -> 3000 (Let's Encrypt)"
fi

# --- Dokploy's own domain -------------------------------------------------
# Web Server, Server Domain in the UI. The procedure exists in this Dokploy
# version; if a future one renames it, the message says so and the field is
# one click in the UI.
if post settings.assignDomainServer "$(jq -cn --arg host "$dokploy_host" \
  '{host: $host, certificateType: "letsencrypt", letsEncryptEmail: "", https: true}')" >/dev/null 2>&1; then
  echo "Dokploy's own domain https://$dokploy_host"
else
  echo "could not set Dokploy's own domain through the API; set $dokploy_host under Settings, Web Server" >&2
fi

# --- Traefik: pin the control-plane hosts (#9 trust) ----------------------
# A Dokploy member token may attach any host to a preview application; these
# priority routers keep dokploy.<env> and api.<env> with their owners. A run
# that cannot write them stops before the deployment (ADR-048).
app_name=$(get "application.one?applicationId=$app_id" | jq -r .appName)
if [ -z "$app_name" ] || [ "$app_name" = null ]; then
  echo "application api has no appName; control-plane routers not written" >&2
  exit 1
fi
file=$(cat <<YAML
# Written by infra/scripts/dokploy-setup.sh once Dokploy has its owner; first boot writes none (ADR-048).
http:
  routers:
    control-plane-dokploy:
      rule: Host(\`$dokploy_host\`)
      priority: 1000
      service: control-plane-dokploy
      entryPoints: [web]
      middlewares: [redirect-to-https]
    control-plane-dokploy-secure:
      rule: Host(\`$dokploy_host\`)
      priority: 1000
      service: control-plane-dokploy
      entryPoints: [websecure]
      tls:
        certResolver: letsencrypt
    control-plane-api:
      rule: Host(\`$api_host\`)
      priority: 1000
      service: control-plane-api
      entryPoints: [web]
      middlewares: [redirect-to-https]
    control-plane-api-secure:
      rule: Host(\`$api_host\`)
      priority: 1000
      service: control-plane-api
      entryPoints: [websecure]
      tls:
        certResolver: letsencrypt
  services:
    control-plane-dokploy:
      loadBalancer:
        servers:
          - url: http://dokploy:3000
        passHostHeader: true
    control-plane-api:
      loadBalancer:
        servers:
          - url: http://$app_name:3000
        passHostHeader: true
YAML
)
writes=$(jq -cn --arg f "$file" '["cat > /etc/dokploy/traefik/dynamic/00-control-plane.yml <<'"'"'EOF'"'"'", $f, "EOF"]')
# On staging the same command writes the router that asks the DNS resolver for
# the previews' one certificate (ADR-053). Nothing resolves to its host, so it
# serves no request; a preview's own router finds the wildcard in the store.
if [ -n "$preview_domain" ]; then
  preview_file=$(cat <<YAML
# Written by infra/scripts/dokploy-setup.sh on staging: the previews' one certificate (ADR-053).
http:
  routers:
    preview-certificate:
      rule: Host(\`$preview_domain\`)
      entryPoints: [websecure]
      service: noop@internal
      tls:
        certResolver: letsencrypt-dns
        domains:
          - main: "*.$preview_domain"
YAML
)
  writes=$(jq -c --arg p "$preview_file" '. + ["cat > /etc/dokploy/traefik/dynamic/01-preview-certificate.yml <<'"'"'EOF'"'"'", $p, "EOF"]' <<< "$writes")
fi
# set -e: Run Command reports the last command's status, so a failed write
# must stop before "echo written".
cmd=$(jq -cn --argjson w "$writes" '{commands: (["set -e"] + $w + ["echo written"])}')
cid=$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript --comment "Traefik routers (dokploy-setup.sh)" --parameters "$cmd" --query 'Command.CommandId' --output text)
for _ in $(seq 1 20); do
  st=$(aws ssm get-command-invocation --command-id "$cid" --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null || echo Pending)
  case "$st" in Success|Failed|TimedOut|Cancelled) break ;; esac
  sleep 3
done
echo "Traefik control-plane routers for $dokploy_host and $api_host -> $app_name: $st"
if [ "$st" != Success ]; then
  echo "control-plane routers not written (see infra/README.md Previews, Trust); run again" >&2
  exit 1
fi
[ -z "$preview_domain" ] || echo "Traefik router for the previews' certificate, *.$preview_domain"

# --- Traefik: one certificate for every preview (staging, ADR-053) ---------
# A second resolver obtains *.$preview_domain by DNS-01 with the instance
# role, whose one right in DNS is the TXT record at _acme-challenge of that
# name (envs/staging/dns.tf). The resolver is in traefik.yml and its two
# variables in Traefik's environment, both Dokploy's, so a rebuilt box needs
# this run again: the backup holds traefik.yml, not the container's
# environment. The AWS SDK wants a region even for Route 53; the zone's id
# spares lego a lookup it has no right to.
if [ -n "$preview_domain" ]; then
  zone_id=$(aws route53 list-hosted-zones-by-name --dns-name kuutti.app --query 'HostedZones[?Name==`kuutti.app.`].Id | [0]' --output text)
  zone_id="${zone_id#/hostedzone/}"
  [[ "$zone_id" =~ ^Z[0-9A-Z]+$ ]] || { echo "no hosted zone kuutti.app (got '$zone_id')" >&2; exit 1; }

  restart=false
  traefik_yml=$(get settings.readTraefikConfig | jq -r '. // empty')
  [ -n "$traefik_yml" ] || { echo "Dokploy returned no traefik.yml" >&2; exit 1; }
  if ! grep -qx '  letsencrypt-dns:' <<< "$traefik_yml"; then
    [ "$(grep -cx 'certificatesResolvers:' <<< "$traefik_yml")" = 1 ] || {
      echo "traefik.yml has no single certificatesResolvers: line; add the resolver of ADR-053 under Settings, Web Server, Traefik" >&2
      exit 1
    }
    traefik_yml=$(awk '{ print } $0 == "certificatesResolvers:" {
      print "  letsencrypt-dns:"; print "    acme:"; print "      storage: /etc/dokploy/traefik/dynamic/acme.json"
      print "      dnsChallenge:"; print "        provider: route53" }' <<< "$traefik_yml")
    post settings.updateTraefikConfig "$(jq -cn --arg c "$traefik_yml" '{traefikConfig: $c}')" >/dev/null
    # Dokploy logs a failed write and answers true all the same.
    get settings.readTraefikConfig | jq -r '. // empty' | grep -qx '  letsencrypt-dns:' || {
      echo "traefik.yml did not take the resolver letsencrypt-dns" >&2
      exit 1
    }
    echo "traefik.yml: resolver letsencrypt-dns (DNS-01, route53)"
    restart=true
  fi

  traefik_env=$(get settings.readTraefikEnv | jq -r '. // ""')
  if ! grep -qx 'AWS_REGION=eu-central-1' <<< "$traefik_env" || ! grep -qx "AWS_HOSTED_ZONE_ID=$zone_id" <<< "$traefik_env"; then
    traefik_env=$({ grep -v -e '^AWS_REGION=' -e '^AWS_HOSTED_ZONE_ID=' <<< "$traefik_env" || true; printf 'AWS_REGION=eu-central-1\nAWS_HOSTED_ZONE_ID=%s\n' "$zone_id"; } | sed '/^$/d')
    # Dokploy recreates Traefik with it, in the background, from the version it pins.
    post settings.writeTraefikEnv "$(jq -cn --arg e "$traefik_env" '{env: $e}')" >/dev/null
    echo "Traefik's environment: AWS_REGION, AWS_HOSTED_ZONE_ID; Dokploy recreates Traefik"
    restart=true
  elif [ "$restart" = true ]; then
    post settings.reloadTraefik '{}' >/dev/null
    echo "Traefik restarts for its new resolver"
  fi

  # While Traefik is down, a DOKPLOY_URL behind it does not answer.
  if [ "$restart" = true ]; then
    sleep 15
    for i in $(seq 1 36); do
      now=$(get settings.readTraefikEnv 2>/dev/null | jq -r '. // ""' 2>/dev/null || true)
      grep -qx "AWS_HOSTED_ZONE_ID=$zone_id" <<< "$now" && break
      [ "$i" -lt 36 ] || { echo "Traefik was not back with its environment within 3 minutes; see Settings, Web Server, Traefik" >&2; exit 1; }
      sleep 5
    done
    echo "Traefik is back"
  fi
fi

# --- deploy ----------------------------------------------------------------
post application.deploy "$(jq -cn --arg id "$app_id" --arg d "$image" '{applicationId: $id, title: "dokploy-setup.sh", description: $d}')" >/dev/null
echo "deploying; waiting"
for _ in $(seq 1 120); do
  case "$(get "application.one?applicationId=$app_id" | jq -r '.applicationStatus // "unknown"')" in
    done) echo "deployed"; break ;;
    error) echo "deployment failed; see the Deployments tab" >&2; exit 1 ;;
  esac
  sleep 5
done

# The wildcard answers any name under the preview domain, an application or
# not; Traefik's default certificate means it is not there (yet).
if [ -n "$preview_domain" ]; then
  echo "waiting for Traefik to serve *.$preview_domain"
  for i in $(seq 1 60); do
    served=$(openssl s_client -connect "check.$preview_domain:443" -servername "check.$preview_domain" </dev/null 2>/dev/null | openssl x509 -noout -subject 2>/dev/null || true)
    if grep -qF "*.$preview_domain" <<< "$served"; then echo "served: $served"; break; fi
    [ "$i" -lt 60 ] || { echo "no certificate for *.$preview_domain after 5 minutes; Traefik's log is /kuutti/$env/api, stream dokploy-traefik (ADR-053)" >&2; exit 1; }
    sleep 5
  done
fi

cat <<TXT

application id: $app_id
Next, from the repository root:
  gh variable set DOKPLOY_URL --env $env --body https://$dokploy_host
  gh variable set DOKPLOY_APPLICATION_ID --env $env --body $app_id
  gh secret set DOKPLOY_TOKEN --env $env          # prompts; paste the API key
Then every push to main deploys (deploy.yml) and /health must report the commit.
TXT
