# ---------------------------------------------------------------------------
# The project domain (TD-4). kuutti.app was registered through Route 53 in
# this account on 2026-09-17: a purchase with contact details, which cannot be
# code, so like the account itself it is the click-ops ADR-001 allows. Route 53
# created the hosted zone at registration. It is adopted here rather than
# recreated: a new zone would get other name servers than the registration
# points at. The import block stays, so a rebuilt state adopts it again.
# Records live with the environment that owns their target (envs/*/dns.tf)
# and look the zone up by name. Domain-wide records that belong to no
# environment live here: CAA, the root's SPF, DMARC and null MX below, and
# the records SES sends mail by (mail.tf).
# ---------------------------------------------------------------------------

import {
  to = aws_route53_zone.main
  id = "Z004088624ZDOS9GD322O"
}

resource "aws_route53_zone" "main" {
  name    = var.domain
  comment = "HostedZone created by Route53 Registrar"

  lifecycle {
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# Domain-wide policy records. Kuutti sends as noreply@kuutti.app through SES
# and receives no mail at all (mail.tf, #385, ADR-043 §5). SES signs every
# message with DKIM as d=kuutti.app, and its envelope sender is
# mail.kuutti.app, whose own SPF names SES. So the root keeps its "-all" SPF
# (nothing sends with kuutti.app itself in the envelope) and its null MX
# (nothing receives here), and the reject DMARC holds: DKIM aligns under
# adkim=s, while SPF, checked for mail.kuutti.app, does not align under
# aspf=s and need not. Mail that SES did not sign fails DMARC and receivers
# that honour it reject it, which is what stops the domain being spoofed. CAA
# limits who may issue certificates for the domain to the two issuers in use:
# ACM (Amplify Hosting, later CloudFront) and Let's Encrypt (Traefik on the
# boxes). No issuewild, so issue governs wildcards too (RFC 8659): the one
# wildcard is the previews', *.preview.api.staging, whose own CAA in
# envs/staging/dns.tf admits Let's Encrypt by DNS-01 alone (ADR-053). When the
# project has a mailbox, add an iodef record and replace the SPF and the null
# MX.
# ---------------------------------------------------------------------------

resource "aws_route53_record" "caa" {
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain
  type    = "CAA"
  ttl     = 3600
  records = [
    "0 issue \"amazon.com\"",
    "0 issue \"amazontrust.com\"",
    "0 issue \"awstrust.com\"",
    "0 issue \"amazonaws.com\"",
    "0 issue \"letsencrypt.org\"",
  ]
}

resource "aws_route53_record" "spf" {
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain
  type    = "TXT"
  ttl     = 3600
  records = ["v=spf1 -all"]
}

resource "aws_route53_record" "dmarc" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = 3600
  records = ["v=DMARC1; p=reject; adkim=s; aspf=s"]
}

# RFC 7505: a null MX tells senders the domain accepts no mail at all.
resource "aws_route53_record" "null_mx" {
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain
  type    = "MX"
  ttl     = 3600
  records = ["0 ."]
}

# GitHub organisation domain verification (#16 B.1): the organisation shows
# kuutti.app as verified once this record answers. An owner starts the
# verification in the organisation's settings (Verified and approved domains),
# which shows the record name and its code; both go into terraform.tfvars.
# The code is a proof of control, not a secret. Empty until then: no record.
resource "aws_route53_record" "github_org_verification" {
  count   = var.github_domain_verification == null ? 0 : 1
  zone_id = aws_route53_zone.main.zone_id
  name    = "${var.github_domain_verification.name}.${var.domain}"
  type    = "TXT"
  ttl     = 300
  records = [var.github_domain_verification.code]
}
