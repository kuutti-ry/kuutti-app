# ---------------------------------------------------------------------------
# Mail (#385, ADR-043 §5). Kuutti sends one kind of message, the code that
# confirms an address, from noreply@kuutti.app through SES, and receives none.
# The identity is the whole domain and belongs to no environment, like the
# zone's DMARC (dns.tf); each environment's instance role may send through it
# from that one address (modules/compute). SES identities are regional: this
# one lives in var.region, which must stay the region the API's SES client
# uses (S3_REGION, eu-central-1 by default, TD-4). Staging and production are
# one account in that region, so they share the identity, the suppression
# list and the sandbox; production access is the maintainer's request, once
# for both (README, Mail).
# ---------------------------------------------------------------------------

locals {
  mail_from_domain = "mail.${var.domain}"
}

# Easy DKIM: SES keeps the keys and signs every message as d=kuutti.app, which
# aligns with the From address under the zone's adkim=s, so DMARC passes
# through DKIM (ADR-043 §5). The CNAMEs point at the public halves SES
# publishes, so a new key needs no change here. The identity counts as
# verified once SES has found them (README, Mail).
resource "aws_sesv2_email_identity" "main" {
  email_identity = var.domain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_route53_record" "dkim" {
  count = 3 # Easy DKIM always issues three tokens

  zone_id = aws_route53_zone.main.zone_id
  name    = "${aws_sesv2_email_identity.main.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 3600
  records = ["${aws_sesv2_email_identity.main.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

# The envelope sender is mail.kuutti.app rather than SES's amazonses.com: SPF
# then passes for a name of this domain, and bounces return to SES through
# the MX below, which feeds the suppression list. Under the zone's aspf=s it
# does not align with kuutti.app; DMARC rests on DKIM alone (dns.tf).
#
# REJECT_MESSAGE: while SES cannot see that MX it refuses to send instead of
# falling back to amazonses.com without a word. The refusal shows: the API
# answers 503 mail_unavailable, counts nothing and logs "email code not sent"
# with the SDK's error name. The fallback would quietly drop the envelope this
# file declares. The MX is declared beside it, so a refusal means a broken
# zone, or the minutes after the first apply before SES has looked.
resource "aws_sesv2_email_identity_mail_from_attributes" "main" {
  email_identity         = aws_sesv2_email_identity.main.email_identity
  mail_from_domain       = local.mail_from_domain
  behavior_on_mx_failure = "REJECT_MESSAGE"
}

resource "aws_route53_record" "mail_from_mx" {
  zone_id = aws_route53_zone.main.zone_id
  name    = local.mail_from_domain
  type    = "MX"
  ttl     = 3600
  records = ["10 feedback-smtp.${var.region}.amazonses.com"]
}

# SES's own servers and no others may use this envelope: -all, where AWS's
# example has ~all, since nothing else ever sends with it.
resource "aws_route53_record" "mail_from_spf" {
  zone_id = aws_route53_zone.main.zone_id
  name    = local.mail_from_domain
  type    = "TXT"
  ttl     = 3600
  records = ["v=spf1 include:amazonses.com -all"]
}

# The record of bounces and complaints that AWS asks about before it grants
# production access (ADR-043 §5): SES puts every address that bounced hard or
# complained on the account's suppression list and delivers nothing more to
# it. The list is per account and region, so it covers both environments.
# #196 extends it with the events and Kuutti's own list.
resource "aws_sesv2_account_suppression_attributes" "main" {
  suppressed_reasons = ["BOUNCE", "COMPLAINT"]
}
