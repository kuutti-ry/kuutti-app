# ---------------------------------------------------------------------------
# The project domain (TD-4). kuutti.app was registered through Route 53 in
# this account on 2026-09-17: a purchase with contact details, which cannot be
# code, so like the account itself it is the click-ops ADR-001 allows. Route 53
# created the hosted zone at registration. It is adopted here rather than
# recreated: a new zone would get other name servers than the registration
# points at. The import block stays, so a rebuilt state adopts it again.
# Records live with the environment that owns their target (envs/*/dns.tf)
# and look the zone up by name. Domain-wide records that belong to no
# environment live here: CAA, DMARC and the root's MX and SPF below with
# Google Workspace's key and verification, and the records SES sends mail by
# (mail.tf).
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
# Domain-wide policy records. Two services send as kuutti.app, and one of them
# receives (#450, ADR-043 §5):
# - Google Workspace holds the association's mailbox, admin@kuutti.app, which
#   every alarm mails (ALERT_EMAIL). It receives through the root's MX. It
#   sends with the sender's own address in the envelope, so the root's SPF
#   names Google, and it signs as d=kuutti.app with the key at
#   google._domainkey.
# - SES sends Kuutti's own mail as noreply@kuutti.app (mail.tf, #385). Its
#   envelope sender is mail.kuutti.app, whose own SPF names SES, so the root's
#   SPF need not, and Easy DKIM signs as d=kuutti.app.
# The reject DMARC holds for both: each signature aligns under adkim=s, and
# Google's envelope also aligns under aspf=s, while SES's, checked for
# mail.kuutti.app, does not and need not. Mail that neither signed fails
# DMARC, and receivers that honour it reject it, which is what stops the
# domain being spoofed. The one exception is mail that leaves Google's servers
# with a kuutti.app envelope: it passes on SPF alone, so that part rests on
# Google refusing such an envelope to its other customers. The SPF ends in ~all, Google's advice, rather than
# -all: DMARC does the rejecting, and a receiver that refuses a hard SPF fail
# outright never sees that a forwarded message's DKIM still passes.
#
# The maintainer set the Workspace up in the console on 2026-10-03, and Google
# gave a new verification code on 2026-10-15 (CloudTrail). The records are
# declared as they were live on 2026-10-25, and Google's key is adopted with
# an import block. In Route 53 a name has one TXT set, so Google's
# verification shares the root's with the SPF.
#
# CAA limits who may issue certificates for the domain to the two issuers in
# use: ACM (Amplify Hosting, later CloudFront) and Let's Encrypt (Traefik on
# the boxes). An issuer that refuses a request against it may report it to
# the mailbox (iodef). No issuewild, so issue governs wildcards too (RFC
# 8659): Amplify's ACM certificate for *.kuutti.app renews under the
# amazon.com entries, and the previews' *.preview.api.staging has its own CAA
# in envs/staging/dns.tf, which admits Let's Encrypt by DNS-01 alone
# (ADR-053); an issuewild here would have to admit ACM as well.
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
    "0 iodef \"mailto:admin@${var.domain}\"",
  ]
}

# The records were the root's "-all" SPF and its null MX until the Workspace
# (#450): the same objects under the names of what they hold now.
moved {
  from = aws_route53_record.spf
  to   = aws_route53_record.root_txt
}

moved {
  from = aws_route53_record.null_mx
  to   = aws_route53_record.root_mx
}

resource "aws_route53_record" "root_txt" {
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain
  type    = "TXT"
  ttl     = 300
  records = [
    "v=spf1 include:_spf.google.com ~all",
    # Google's proof that the domain is the association's, public like every
    # record. It stays after the check, since Google may read it again.
    "google-site-verification=POL6Nb15K44JSndMSeLscRDnM-1RtytXRDH_XyiM4tw",
  ]
}

resource "aws_route53_record" "dmarc" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = 3600
  records = ["v=DMARC1; p=reject; adkim=s; aspf=s"]
}

resource "aws_route53_record" "root_mx" {
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain
  type    = "MX"
  ttl     = 3600
  records = ["1 smtp.google.com"]
}

import {
  to = aws_route53_record.google_dkim
  id = "Z004088624ZDOS9GD322O_google._domainkey.kuutti.app_TXT"
}

# The public half of the key Google signs the Workspace's mail with, the
# selector "google". A TXT string holds at most 255 characters, so the key is
# two strings, split where the Workspace's Admin console split it. A new key
# from Google replaces both.
resource "aws_route53_record" "google_dkim" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "google._domainkey.${var.domain}"
  type    = "TXT"
  ttl     = 300
  records = [join("\" \"", [
    "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvqLTCdakQ5D+LJUEWLQE0nx4O3T8P0z9vu8NqKboujRg3MtHKSKe+okW7VLONmAiaMdfYGHJnpDJTr9s97W7A2kzoMy7APkKBJfW7fFNioqiN4CdMwADOPph5Yfkf9A97cGGbsZv8d",
    "KNUwyJ/Q1SiHCPNrYXgJl6vSZlguoc+b+LzslM+z4SEk0d6iXmfr7DnECG51iCmpFz04jXtmcJwBj4lQXnLmMDG/Y56p6oexvSN7qCw/7eRTMVhcderPnzn8tjoGKNJFl682EcU7zV9RuivQwawDXG1mFHS1tCdIPJ75b/c1z62dSsDJyWzpx9W5ZMlLmDxQWFLUZ0y+9bAwIDAQAB",
  ])]
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
