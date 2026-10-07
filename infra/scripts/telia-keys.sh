#!/usr/bin/env bash
# Generates Kuutti's two Telia Tunnistus keys (docs/vendors/telia.md; guide
# 2.1.1: RSA, one for signing, one for encryption) straight onto the offline
# medium, writes their public halves as the JWKs Telia is sent, and, with
# --put, loads the private halves into SSM (infra/README.md, Secrets). Nothing
# secret is printed or passed on a command line: the JWKs and their kids are
# public values, the same kids the API logs at boot under "bank identification".
#
#   infra/scripts/telia-keys.sh staging /Volumes/<offline-medium>
#   infra/scripts/telia-keys.sh staging /Volumes/<offline-medium> --put
#
# Writes to <offline-dir>: kuutti-<env>-telia-{sig,enc}.pem (private, mode 600),
# kuutti-<env>-telia-{sig,enc}.pub.pem, and kuutti-<env>-telia-jwks.json, the
# two public keys in the shape Telia asks for, which is what goes to
# id-maintenance@teliacompany.com. Refuses to overwrite a key: a Telia key is
# replaced by rotation (docs/runbooks/custody.md), never in place.
# Needs openssl and node; --put needs aws, signed in (pnpm aws:login).
set -euo pipefail

usage="usage: telia-keys.sh <staging|prod> <offline-dir> [--put]"
env="${1:?$usage}"
dir="${2:?$usage}"
put="${3:-}"
case "$env" in staging|prod) ;; *) echo "environment must be staging or prod" >&2; exit 2 ;; esac
case "$put" in ""|--put) ;; *) echo "unknown argument $put ($usage)" >&2; exit 2 ;; esac
[ -d "$dir" ] || { echo "$dir is not a directory; mount the offline medium first" >&2; exit 2; }
for tool in openssl node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is not installed" >&2; exit 1; }
done
[ "$put" != "--put" ] || command -v aws >/dev/null 2>&1 || { echo "aws is not installed" >&2; exit 1; }

prefix="$dir/kuutti-$env-telia"

if [ ! -e "$prefix-sig.pem" ] && [ ! -e "$prefix-enc.pem" ]; then
  # 3072 bits: Telia's minimum is 2048. Private files are created readable by
  # the owner only; the public halves and the JWKs may be read by anyone.
  (
    umask 077
    for use in sig enc; do
      openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$prefix-$use.pem" 2>/dev/null
    done
  )
  for use in sig enc; do
    openssl pkey -in "$prefix-$use.pem" -pubout -out "$prefix-$use.pub.pem"
  done
  echo "generated $prefix-sig.pem and $prefix-enc.pem"
elif [ -e "$prefix-sig.pem" ] && [ -e "$prefix-enc.pem" ]; then
  echo "keys exist on $dir; writing their JWKs again, generating nothing"
else
  echo "one of $prefix-sig.pem and $prefix-enc.pem exists without the other; sort that out by hand" >&2
  exit 3
fi

# The JWKs as the guide's sample has them (2.3.1; the kid is the RFC 7638
# thumbprint, as in Telia's own Python sample, and the API computes the same
# from the private key, keyIdOf), and around them the client metadata in the
# shape of that sample's client.json: what "the protocol's metadata" of Telia's
# offer means for OIDC. Telia answers with the client_id. The redirect URI is
# the one envs/<env>/dns.tf gives the API; the contact is the association's
# mailbox (TD-4), from KUUTTI_TELIA_CONTACT so that no address is in the repo.
case "$env" in
  staging) redirect="https://api.staging.kuutti.app/auth/callback" ;;
  prod) redirect="https://api.kuutti.app/auth/callback" ;;
esac
node - "$prefix" "$redirect" "${KUUTTI_TELIA_CONTACT:-}" <<'EOF'
const { createHash, createPublicKey } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const [prefix, redirect, contact] = process.argv.slice(2);
const keys = ["sig", "enc"].map((use) => {
  const jwk = createPublicKey(readFileSync(`${prefix}-${use}.pub.pem`)).export({ format: "jwk" });
  const kid = createHash("sha256")
    .update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
    .digest("base64url");
  return { kty: jwk.kty, use, kid, alg: use === "sig" ? "RS256" : "RSA-OAEP", n: jwk.n, e: jwk.e };
});
const client = {
  organization_name: "Kuutti ry",
  contacts: [contact || "<the association's mailbox>"],
  "client_name#fi": "Kuutti",
  "client_name#sv": "Kuutti",
  "client_name#en": "Kuutti",
  ftn_spname: "Kuutti",
  client_uri: "https://kuutti.app",
  redirect_uris: [redirect],
  grant_types: ["authorization_code"],
  scope: "openid",
  require_signed_request_object: true,
  request_object_signing_alg: "RS256",
  token_endpoint_auth_method: "private_key_jwt",
  token_endpoint_auth_signing_alg: "RS256",
  id_token_signed_response_alg: "RS256",
  id_token_encrypted_response_alg: "RSA-OAEP",
  id_token_encrypted_response_enc: "A128CBC-HS256",
  jwks: { keys },
};
writeFileSync(`${prefix}-jwks.json`, `${JSON.stringify({ keys }, null, 2)}\n`);
writeFileSync(`${prefix}-client.json`, `${JSON.stringify(client, null, 2)}\n`);
EOF
echo "for Telia: $prefix-client.json (the client metadata with both public keys; $prefix-jwks.json holds the keys alone)"
[ -n "${KUUTTI_TELIA_CONTACT:-}" ] || echo "  contacts is a placeholder: set KUUTTI_TELIA_CONTACT to the association's mailbox and run again, or edit the file"
node -e 'for (const k of require(process.argv[1]).keys) console.log(`  ${k.use}  kid ${k.kid}`)' "$prefix-jwks.json"

if [ "$put" = "--put" ]; then
  # file:// keeps the key out of the shell history and the process list; no
  # --overwrite, so a second run cannot replace a key that is in use.
  aws ssm put-parameter --name "/kuutti/$env/telia-signing-key" --type SecureString --value "file://$prefix-sig.pem" >/dev/null
  aws ssm put-parameter --name "/kuutti/$env/telia-encryption-key" --type SecureString --value "file://$prefix-enc.pem" >/dev/null
  echo "stored /kuutti/$env/telia-signing-key and /kuutti/$env/telia-encryption-key"
else
  echo "the private keys stay on $dir; run again with --put, after pnpm aws:login, to load them into SSM"
fi
