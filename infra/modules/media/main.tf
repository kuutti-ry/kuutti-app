# Photo storage and delivery (#48, ADR-005, TD-2, TD-8): a private bucket the
# API writes variants into through the instance role, and one CloudFront
# distribution on api.<env>.<domain> with two origins: /media/* is the bucket,
# reachable only with a URL the API signed (fifteen minutes, one object),
# everything else is the API on the box. TLS terminates at CloudFront with an
# ACM certificate from us-east-1; the hop to the box is HTTPS to
# origin.api.<env>.<domain>, whose certificate Traefik holds.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name        = "${var.project}-${var.environment}"
  account_id  = data.aws_caller_identity.current.account_id
  bucket_name = "${var.project}-media-${var.environment}-${local.account_id}"
  # The API writes media/<sha256 of the full variant>/<variant>.webp (apps/api/src/media/store.ts).
  media_prefix = "media/"
  # The research copy, research/YYYY/MM/YYYY-MM-DD.parquet (#194, ADR-029;
  # COPY_PREFIX in apps/api/src/research/copy-store.ts). modules/research holds
  # who may read and write it; the lifecycle rule is here, since a bucket has one.
  research_prefix = "research/"
}

# ---------------------------------------------------------------------------
# The bucket. Private; the only readers are the API (instance role), the
# distribution (origin access control, media/ only) and the researcher's
# role (research/ only, modules/research). Versioning stays off on purpose: a
# deleted photo must be gone (TD-7 erasure), not retained as a version.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "media" {
  bucket = local.bucket_name

  tags = { Name = local.bucket_name }
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket = aws_s3_bucket.media.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  # SSE-S3; a bucket key is an SSE-KMS construct and has no place here.
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id

  versioning_configuration {
    status = "Disabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  # S3's default since September 2024, spelled out for the research rule
  # below: an object under 128 KB transitions nowhere. Glacier Instant
  # Retrieval bills every object as at least 128 KB and each transition is a
  # request, so a small day file costs more there than it does in Standard.
  # ("varies_by_storage_class" would not change that: it lets small objects
  # reach Glacier Flexible Retrieval and Deep Archive only.)
  transition_default_minimum_object_size = "all_storage_classes_128K"

  # The API uploads whole objects; a multipart upload left behind by a crash is garbage after a day.
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {
      prefix = local.media_prefix
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  # The research copy (#194, ADR-029 §8): a day's file of 128 KB or more
  # moves to Glacier Instant Retrieval after a year, read the same way and at
  # once, cheaper to keep and dearer to read. No expiry: how long the copy
  # lives is the maintainer's decision, not a default.
  rule {
    id     = "research-to-glacier-ir"
    status = "Enabled"

    filter {
      prefix = local.research_prefix
    }

    transition {
      days          = 365
      storage_class = "GLACIER_IR"
    }
  }
}

# The instance role writes and removes variants under media/ (rules/infra.md:
# the role is scoped to its bucket); its rights under research/, write once
# and never remove, are modules/research's.
data "aws_iam_policy_document" "api_media" {
  statement {
    sid       = "MediaObjects"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.media.arn}/${local.media_prefix}*"]
  }

  statement {
    sid       = "MediaList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.media_prefix}*"]
    }
  }
}

resource "aws_iam_role_policy" "api_media" {
  name   = "media-bucket"
  role   = var.instance_role_name
  policy = data.aws_iam_policy_document.api_media.json
}

# ---------------------------------------------------------------------------
# Signed URLs. The public halves of the key pairs are CloudFront public keys
# in one key group the media behaviour trusts; the private half of the current
# key is read by the API from SSM at boot (rules/infra.md Secrets) and signs
# each URL for fifteen minutes. Every key is named by a hash of its PEM, so a
# changed key is a new resource next to the old one, never a replacement
# fighting over a name. Rotation: commit the new public half as an additional
# key (both trusted), switch the SSM value and the current file, restart the
# API, then drop the old file (infra/README.md, Media).
# ---------------------------------------------------------------------------

locals {
  # The current key first: its id is what the API puts in every URL.
  signing_keys = {
    for pem in concat([var.signing_public_key_pem], var.additional_signing_public_keys_pem) :
    substr(sha256(pem), 0, 12) => pem
  }
  current_signing_key = substr(sha256(var.signing_public_key_pem), 0, 12)
}

resource "aws_cloudfront_public_key" "signing" {
  for_each = local.signing_keys

  name        = "${local.name}-media-signing-${each.key}"
  comment     = "A public half of /kuutti/${var.environment}/cloudfront-signing-key (ADR-005)"
  encoded_key = each.value

  lifecycle {
    precondition {
      condition     = can(regex("BEGIN PUBLIC KEY", each.value))
      error_message = "every signing key must be a PEM public key: commit infra/envs/<env>/cloudfront-signing-key.pub.pem before setting media_enabled (infra/README.md, Media)."
    }
  }
}

resource "aws_cloudfront_key_group" "signing" {
  name    = "${local.name}-media-signing"
  comment = "Key group the media behaviour trusts"
  items   = [for key in aws_cloudfront_public_key.signing : key.id]
}

resource "aws_cloudfront_origin_access_control" "media" {
  name                              = "${local.name}-media"
  description                       = "The distribution reads the media bucket; nothing else does"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# The signature travels in the query string, and the query string is not part
# of the cache key (rules/infra.md CloudFront): one cached object per variant
# however many URLs were signed for it. CloudFront checks the signature before
# it looks at the cache, so a cached object is still served only to a valid URL.
resource "aws_cloudfront_cache_policy" "media" {
  name        = "${local.name}-media"
  comment     = "Content-addressed WebP variants: long TTL, no query string, no cookies, no headers"
  min_ttl     = 0
  default_ttl = 86400
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = false
    enable_accept_encoding_gzip   = false

    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

# The API behaviour: nothing cached, every viewer header (Host included, so
# Traefik routes by it and the API sees its public name), cookies and query
# strings forwarded, plus the headers CloudFront itself adds: the viewer
# address the rate limiter keys on once the box admits CloudFront alone (#52,
# audit F19) and the distribution's request id for the logs. The policy also
# carries the Sec-WebSocket-* headers.
data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewerAndCloudFrontHeaders-2022-06"
}

# ---------------------------------------------------------------------------
# The certificate for the alias, in us-east-1 as CloudFront requires, validated
# by a record in the project zone.
# ---------------------------------------------------------------------------

resource "aws_acm_certificate" "api" {
  provider = aws.us_east_1

  domain_name       = var.api_fqdn
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = var.api_fqdn }
}

resource "aws_route53_record" "validation" {
  for_each = {
    for dvo in aws_acm_certificate.api.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id         = var.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.record]
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "api" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = [for record in aws_route53_record.validation : record.fqdn]
}

# ---------------------------------------------------------------------------
# The distribution.
# ---------------------------------------------------------------------------

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${local.name}: the API and its photos (ADR-005)"
  http_version    = "http2and3"
  # Europe and North America: Finland is served from Europe, and the rest of
  # the classes add edges nobody here reaches.
  price_class = "PriceClass_100"
  aliases     = [var.api_fqdn]

  origin {
    origin_id                = "media"
    domain_name              = aws_s3_bucket.media.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.media.id
  }

  origin {
    origin_id   = "api"
    domain_name = var.origin_fqdn

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
    }
  }

  default_cache_behavior {
    target_origin_id         = "api"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
    compress                 = false
  }

  ordered_cache_behavior {
    path_pattern           = "${local.media_prefix}*"
    target_origin_id       = "media"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = aws_cloudfront_cache_policy.media.id
    trusted_key_groups     = [aws_cloudfront_key_group.signing.id]
    compress               = false
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.api.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = { Name = "${local.name}-api" }
}

# Only this distribution reads the bucket, and only under media/.
data "aws_iam_policy_document" "bucket" {
  statement {
    sid       = "CloudFrontRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/${local.media_prefix}*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket = aws_s3_bucket.media.id
  policy = data.aws_iam_policy_document.bucket.json

  depends_on = [aws_s3_bucket_public_access_block.media]
}

# api.<env>.<domain> is the distribution from here on; the environment's
# dns.tf points origin.api.<env>.<domain> at the box instead.
resource "aws_route53_record" "api" {
  for_each = toset(["A", "AAAA"])

  zone_id = var.zone_id
  name    = var.api_fqdn
  type    = each.key

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}
