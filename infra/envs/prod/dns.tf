# DNS for prod (TD-4): the zone belongs to the bootstrap (adopted from the
# Route 53 registration), the records to the environment that owns the
# address: the API and Dokploy's own UI and API (called by CI). Traefik on the
# box terminates TLS with one Let's Encrypt certificate per host. With
# media_enabled both names are the CloudFront distribution's (ADR-005; §7 and
# #198 for Dokploy) and the box answers to origin.api; without it they point
# at the Elastic IP.

data "aws_route53_zone" "main" {
  name = var.domain
}

# With media_enabled, api is the distribution's alias (modules/media) and the
# box answers to origin.api for CloudFront (ADR-005). Dokploy's name is then
# the distribution's extra alias (ADR-005 §7, #198): the same record with the
# distribution as its target, so that the cutover's apply moves it in one
# change instead of deleting one record and creating another.
locals {
  behind_cloudfront = var.media_enabled ? ["dokploy"] : []
}

resource "aws_route53_record" "box" {
  for_each = toset(concat(["dokploy"], var.media_enabled ? ["origin.api"] : ["api"]))

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

# The distribution answers over IPv6 as well (is_ipv6_enabled), as api does;
# the box has no IPv6 address of its own.
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
