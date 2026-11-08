# DNS for staging (TD-4): the zone belongs to the bootstrap (adopted from the
# Route 53 registration), the records to the environment that owns the
# address: the API, Dokploy's own UI and API (called by CI), and the
# pull-request previews (#9). Traefik on the box terminates TLS with one Let's
# Encrypt certificate per host, and one wildcard for every preview (ADR-053).
# With media_enabled the three names are the CloudFront distribution's
# (ADR-005; §7 and #198 for Dokploy and the previews) and the box answers to
# origin.api.staging; without it they point at the Elastic IP.
# The moderation panel's admin.staging is the alias of its own distribution,
# declared with it in modules/admin (ADR-025).

data "aws_route53_zone" "main" {
  name = var.domain
}

# With media_enabled, api.staging is the distribution's alias (modules/media)
# and the box answers to origin.api.staging for CloudFront (ADR-005).
# Dokploy's name and the previews' are then the distribution's extra aliases
# (ADR-005 §7, #198): the same records with the distribution as their target,
# so that an apply moves each in one change instead of deleting one record and
# creating another.
locals {
  behind_cloudfront = var.media_enabled ? ["dokploy.staging", "*.preview.api.staging"] : []
}

resource "aws_route53_record" "box" {
  for_each = toset(concat(["dokploy.staging", "*.preview.api.staging"], var.media_enabled ? ["origin.api.staging"] : ["api.staging"]))

  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${each.key}.${var.domain}"
  type    = "A"
  ttl     = contains(local.behind_cloudfront, each.key) ? null : 300
  records = contains(local.behind_cloudfront, each.key) ? null : [module.compute.public_ip]

  dynamic "alias" {
    for_each = contains(local.behind_cloudfront, each.key) ? [1] : []
    content {
      name                   = module.media[0].distribution_domain_name
      zone_id                = module.media[0].distribution_hosted_zone_id
      evaluate_target_health = false
    }
  }
}

# The distribution answers over IPv6 as well (is_ipv6_enabled), as
# api.staging does; the box has no IPv6 address of its own.
resource "aws_route53_record" "distribution_ipv6" {
  for_each = toset(local.behind_cloudfront)

  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${each.key}.${var.domain}"
  type    = "AAAA"

  alias {
    name                   = module.media[0].distribution_domain_name
    zone_id                = module.media[0].distribution_hosted_zone_id
    evaluate_target_health = false
  }
}

# The previews share one certificate, *.preview.api.staging, which Traefik on
# the box obtains by DNS-01 with this role (ADR-053, #448). Preview code holds
# the role too, so this is everything a pull request may do in DNS: UPSERT or
# DELETE the TXT record of one name. lego reads the name's values before it
# writes and waits for the change to be in sync.
data "aws_iam_policy_document" "preview_certificate" {
  statement {
    sid       = "PreviewCertificateChallenge"
    actions   = ["route53:ChangeResourceRecordSets"]
    resources = [data.aws_route53_zone.main.arn]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsNormalizedRecordNames"
      values   = ["_acme-challenge.preview.api.staging.${var.domain}"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsRecordTypes"
      values   = ["TXT"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsActions"
      values   = ["UPSERT", "DELETE"]
    }
    # ForAllValues holds for an absent key; the names must be present.
    condition {
      test     = "Null"
      variable = "route53:ChangeResourceRecordSetsNormalizedRecordNames"
      values   = ["false"]
    }
  }

  statement {
    sid       = "PreviewCertificateRead"
    actions   = ["route53:ListResourceRecordSets"]
    resources = [data.aws_route53_zone.main.arn]
  }

  statement {
    sid       = "PreviewCertificateWait"
    actions   = ["route53:GetChange"]
    resources = ["arn:aws:route53:::change/*"]
  }
}

# Under the preview name Let's Encrypt may issue by DNS-01 alone (RFC 8657,
# ADR-053 §5). The wildcard record above answers at any depth, but the
# wildcard certificate covers one label: without this, a member token could
# attach h<k>.pr-<n>.preview hosts and make Traefik order each by HTTP-01. The
# DNS wildcard holds no CAA, so every name below climbs to this record.
# ACM may issue as well (#198), since the distribution's certificate names the
# previews' wildcard. Traefik orders from Let's Encrypt alone, so this gives a
# member token no order of its own.
resource "aws_route53_record" "preview_caa" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "preview.api.staging.${var.domain}"
  type    = "CAA"
  ttl     = 3600
  records = [
    "0 issue \"letsencrypt.org;validationmethods=dns-01\"",
    "0 issue \"amazon.com\"",
  ]
}

resource "aws_iam_role_policy" "preview_certificate" {
  name   = "preview-certificate"
  role   = module.compute.role_name
  policy = data.aws_iam_policy_document.preview_certificate.json
}
