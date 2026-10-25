#!/usr/bin/env bash
# Pull-request previews of the API on the staging box (#9, TD-2, TD-19): one
# Dokploy application per pull request in the previews project, deployed from
# the image build.yml pushed, reachable at https://pr-<n>.$PREVIEW_API_DOMAIN.
# Driven from CI with a Dokploy member token that reaches only that project.
# Dokploy's own GitHub-App previews are not used: they build the branch on
# the box and hand the container nothing but its URL, so neither a
# per-pull-request database nor a per-pull-request CORS origin is possible.
#
#   dokploy-preview.sh list                                # JSON [{pr, applicationId, createdAt, status}]
#   dokploy-preview.sh deploy <pr> <image> <web origin>    # create if missing, point at the image, deploy
#   dokploy-preview.sh delete <pr>                         # remove the application (service, domain, config)
set -euo pipefail
: "${DOKPLOY_URL:?}" "${DOKPLOY_TOKEN:?}" "${DOKPLOY_ENVIRONMENT_ID:?}" "${PREVIEW_API_DOMAIN:?}"

api() {
  curl -fsS --max-time 30 -H "x-api-key: $DOKPLOY_TOKEN" -H 'content-type: application/json' "$@"
}
post() {
  api -X POST "$DOKPLOY_URL/api/$1" --data "$2"
}

# Every application named api-pr-<n> in the previews environment.
list() {
  api "$DOKPLOY_URL/api/environment.one?environmentId=$DOKPLOY_ENVIRONMENT_ID" | jq -c '
    [.applications[]
      | select(.name | test("^api-pr-[0-9]+$"))
      | {pr: (.name | ltrimstr("api-pr-")), applicationId, createdAt, status: .applicationStatus}]
    | sort_by(.pr | tonumber)'
}

application_id() {
  list | jq -r --arg pr "$1" '.[] | select(.pr == $pr) | .applicationId'
}

status() {
  api "$DOKPLOY_URL/api/application.one?applicationId=$1" | jq -r '.applicationStatus // "unknown"'
}

deploy() {
  local pr="$1" image="$2" origin="$3"
  [[ "$pr" =~ ^[0-9]{1,7}$ ]] || { echo "not a pull request number: $pr" >&2; exit 2; }
  local name="api-pr-$pr" host="pr-$pr.$PREVIEW_API_DOMAIN"
  # Only hosts under the preview wildcard: the member token could attach any
  # host, api.staging and dokploy.staging included (the box also pins those
  # two with priority routers, infra/README.md Previews, Trust).
  [[ "$host" == pr-[0-9]*."$PREVIEW_API_DOMAIN" ]] || { echo "refusing host $host" >&2; exit 2; }
  local id
  id=$(application_id "$pr")

  if [ -z "$id" ]; then
    id=$(post application.create "$(jq -cn --arg name "$name" --arg env "$DOKPLOY_ENVIRONMENT_ID" \
      '{name: $name, appName: $name, description: "Pull-request preview, managed by preview.yml (#9)", environmentId: $env, sourceType: "docker"}')" \
      | jq -r .applicationId)
    [ -n "$id" ] && [ "$id" != null ] || { echo "::error::Dokploy did not return an application id" >&2; exit 1; }
    # HTTPS through Traefik under the previews' one wildcard, which covers the
    # host, so Traefik orders nothing; the DNS resolver could not order one for
    # it either (ADR-053). The wildcard DNS record for $PREVIEW_API_DOMAIN points
    # at the box.
    post domain.create "$(jq -cn --arg id "$id" --arg host "$host" \
      '{applicationId: $id, host: $host, path: "/", port: 3000, https: true, certificateType: "custom", customCertResolver: "letsencrypt-dns", domainType: "application"}')" >/dev/null
    echo "created $name ($id) at https://$host"
  else
    echo "updating $name ($id) at https://$host"
    # A cancel between application.create and domain.create leaves an
    # application without a domain that later pushes would never fix.
    if ! api "$DOKPLOY_URL/api/domain.byApplicationId?applicationId=$id" | jq -e --arg h "$host" '.[] | select(.host == $h)' >/dev/null; then
      post domain.create "$(jq -cn --arg id "$id" --arg host "$host" \
        '{applicationId: $id, host: $host, path: "/", port: 3000, https: true, certificateType: "custom", customCertResolver: "letsencrypt-dns", domainType: "application"}')" >/dev/null
      echo "added the missing domain https://$host"
    fi
  fi

  # The image is public on GHCR, so no registry credential.
  post application.saveDockerProvider "$(jq -cn --arg id "$id" --arg image "$image" \
    '{applicationId: $id, dockerImage: $image, username: null, password: null, registryUrl: null}')" >/dev/null

  # Exactly what the staging application gets, plus the preview identity. The
  # API composes DATABASE_URL and everything else from /kuutti/staging/* through
  # the instance role; APP_ENV=preview selects that prefix and PR_NUMBER names
  # the database. Rule 8: the only browser origin is this pull request's web
  # preview.
  local env_text
  env_text=$(printf 'NODE_ENV=production\nAPP_ENV=preview\nPORT=3000\nPR_NUMBER=%s\nCORS_ALLOWED_ORIGINS=%s\nDB_POOL_MAX=3' "$pr" "$origin")
  post application.saveEnvironment "$(jq -cn --arg id "$id" --arg env "$env_text" \
    '{applicationId: $id, env: $env, buildArgs: "", buildSecrets: "", createEnvFile: false}')" >/dev/null

  post application.deploy "$(jq -cn --arg id "$id" --arg image "$image" \
    '{applicationId: $id, title: "preview.yml", description: $image}')" >/dev/null

  # The status is still the previous deployment's for a moment; wait for this
  # one to start, then for it to finish.
  for _ in $(seq 1 12); do
    [ "$(status "$id")" = "running" ] && break
    sleep 5
  done
  for _ in $(seq 1 120); do
    case "$(status "$id")" in
      done) echo "Dokploy finished deploying $name"; return 0 ;;
      error) echo "::error::Dokploy reports the preview deployment of $name failed; see its log in Dokploy"; return 1 ;;
    esac
    sleep 5
  done
  echo "::error::Dokploy did not finish deploying $name within 10 minutes"
  return 1
}

delete() {
  local pr="$1"
  [[ "$pr" =~ ^[0-9]{1,7}$ ]] || { echo "not a pull request number: $pr" >&2; exit 2; }
  local id
  id=$(application_id "$pr")
  if [ -z "$id" ]; then
    echo "no preview application for pull request $pr"
    return 0
  fi
  post application.delete "$(jq -cn --arg id "$id" '{applicationId: $id}')" >/dev/null
  echo "removed api-pr-$pr ($id)"
}

case "${1:-}" in
  list) list ;;
  deploy) deploy "${2:?pull request number}" "${3:?image}" "${4:?web origin}" ;;
  delete) delete "${2:?pull request number}" ;;
  *) echo "usage: dokploy-preview.sh list | deploy <pr> <image> <web origin> | delete <pr>" >&2; exit 2 ;;
esac
