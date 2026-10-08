# The staging environment: network, database and the API box (#7, TD-19).
# Applied by CI through kuutti-ci-apply from the GitHub environment "staging" (#8).

data "aws_caller_identity" "current" {}

locals {
  environment = "staging"
  account_id  = data.aws_caller_identity.current.account_id

  # Bootstrap outputs, reconstructed by name rather than read from its state.
  permissions_boundary_arn = "arn:aws:iam::${local.account_id}:policy/kuutti/kuutti-boundary"
  state_bucket             = "kuutti-tfstate-${local.account_id}"
}

module "network" {
  source = "../../modules/network"

  environment             = local.environment
  vpc_cidr                = var.vpc_cidr
  ssh_cidrs               = var.ssh_cidrs
  cloudfront_only_ingress = var.cloudfront_only_ingress
}

module "data" {
  source = "../../modules/data"

  environment          = local.environment
  instance_class       = var.db_instance_class
  db_subnet_group_name = module.network.db_subnet_group_name
  db_security_group_id = module.network.db_security_group_id
  deletion_protection  = var.db_deletion_protection
}

module "compute" {
  source = "../../modules/compute"

  environment                = local.environment
  instance_type              = var.instance_type
  subnet_id                  = module.network.public_subnet_id
  security_group_id          = module.network.api_security_group_id
  permissions_boundary_arn   = local.permissions_boundary_arn
  backup_bucket              = local.state_bucket
  dokploy_version            = var.dokploy_version
  domain                     = var.domain
  cpu_credits                = "standard" # a pegged staging box slows down instead of costing extra
  manage_session_preferences = true
  preview_databases          = true # pull-request previews run here (#9)
}

# Photos (#48, ADR-005): the media bucket and the CloudFront distribution that
# fronts both the bucket (/media/*, signed URLs) and the API. Dormant until the
# cutover (variable media_enabled); the public half of the signing key pair is
# committed next to this file, the private half is in SSM only.
module "media" {
  count  = var.media_enabled ? 1 : 0
  source = "../../modules/media"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment            = local.environment
  domain                 = var.domain
  zone_id                = data.aws_route53_zone.main.zone_id
  api_fqdn               = "api.staging.${var.domain}"
  origin_fqdn            = "origin.api.staging.${var.domain}"
  instance_role_name     = module.compute.role_name
  signing_public_key_pem = fileexists("${path.module}/cloudfront-signing-key.pub.pem") ? file("${path.module}/cloudfront-signing-key.pub.pem") : ""
  # Rotation (ADR-005): cloudfront-signing-key.<anything>.pub.pem files are trusted too.
  additional_signing_public_keys_pem = [for f in fileset(path.module, "cloudfront-signing-key.*.pub.pem") : file("${path.module}/${f}")]
}

# Alarms, the alert topic and the saved log queries (#11).
module "observability" {
  source = "../../modules/observability"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment    = local.environment
  api_fqdn       = "api.staging.${var.domain}"
  instance_id    = module.compute.instance_id
  db_identifier  = module.data.identifier
  log_group_name = module.compute.log_group_name
  alert_email    = var.alert_email
}

# Non-secret configuration the API reads at boot from /kuutti/staging/ (TD-19).
# Each key becomes the upper-cased environment variable (db-host -> DB_HOST).
# Secrets are never resources (ADR-001): db-app-password comes from
# infra/scripts/db-app-role.sh, the signing keys from their milestones.
resource "aws_ssm_parameter" "config" {
  for_each = merge({
    "app-env"   = "staging"
    "log-level" = "info"
    "db-host"   = module.data.address
    "db-port"   = tostring(module.data.port)
    "db-name"   = module.data.db_name
    "db-user"   = "kuutti_app"
    # Pull-request previews connect as this role (#9); its password is
    # db-preview-password from infra/scripts/db-app-role.sh.
    "db-preview-user" = "kuutti_preview"
    # Photo moderation through Rekognition (#49, ADR-006); the instance role allows the three calls.
    "moderation" = "rekognition"
    # The staff login's return and the panel's origin (#49): without them a
    # deployed box sends the one-time code to localhost and refuses the panel's preflight.
    "admin-app-url"        = var.admin_app_url
    "cors-allowed-origins" = var.cors_allowed_origins
    # The rate limiter's idea of the client address (#52, F19): flips to
    # cloudfront together with cloudfront_only_ingress, never before.
    "trusted-proxy" = var.trusted_proxy
    }, var.media_enabled ? {
    # Photos (#48): what the API needs besides the private key, which is
    # /kuutti/staging/cloudfront-signing-key and never a resource (ADR-001).
    "s3-bucket"              = module.media[0].bucket
    "media-url-base"         = module.media[0].media_url_base
    "cloudfront-key-pair-id" = module.media[0].key_pair_id
    } : {}, var.telia_client_id != null ? {
    # Bank identification (#32, docs/vendors/telia.md): Telia's pre-production
    # issuer, the client it assigned us, the one redirect URI registered there
    # and the level Traficom 213/2023 S has us ask for on the test bed. The API
    # reads its endpoints and keys from the issuer's discovery document at boot.
    "oidc-issuer"       = "https://tunnistus-pp.telia.fi/uas"
    "oidc-client-id"    = var.telia_client_id
    "oidc-redirect-uri" = "https://api.staging.${var.domain}/auth/callback"
    "oidc-acr-values"   = "http://ftn.ficora.fi/2017/loatest2"
  } : {})

  name  = "${module.compute.ssm_prefix}${each.key}"
  type  = "String"
  value = each.value

  lifecycle {
    # ADR-008 §5, enforced: with the origin still open to the world, a
    # cloudfront trusted proxy would let anyone forge the header the rate
    # limiter keys on. The plan fails before the parameter can say so.
    precondition {
      condition     = var.trusted_proxy != "cloudfront" || var.cloudfront_only_ingress
      error_message = "trusted_proxy = cloudfront needs cloudfront_only_ingress = true in the same apply (ADR-008 §5)."
    }
  }
}
