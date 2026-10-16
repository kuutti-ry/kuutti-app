# DNS for staging (TD-4): the zone belongs to the bootstrap (adopted from the
# Route 53 registration), the records to the environment that owns the
# address: the API, Dokploy's own UI and API (called by CI), and the pull-request previews (#9). All point at the Elastic IP; Traefik on the box terminates
# TLS with one Let's Encrypt certificate per host; CloudFront fronts the API once media_enabled is set (ADR-005).
# The moderation panel's admin.staging is the alias of its own distribution,
# declared with it in modules/admin (ADR-025).

data "aws_route53_zone" "main" {
  name = var.domain
}

# With media_enabled, api.staging is the distribution's alias (modules/media)
# and the box answers to origin.api.staging for CloudFront (ADR-005).
resource "aws_route53_record" "box" {
  for_each = toset(concat(["dokploy.staging", "*.preview.api.staging"], var.media_enabled ? ["origin.api.staging"] : ["api.staging"]))

  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${each.key}.${var.domain}"
  type    = "A"
  ttl     = 300
  records = [module.compute.public_ip]
}
