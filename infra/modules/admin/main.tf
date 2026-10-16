# The moderation panel's host (#313, ADR-025, rules/admin.md): a private
# bucket CI writes the panel's Vite build into, and one CloudFront distribution
# of its own on admin.<env>.<domain>, not a path on the API's (the API serves
# /admin/* itself, and the panel's CSP would cover its answers too). A path the
# bucket has no object for is the app, whose router finds the page (#302).
# Every answer carries the panel's headers, whose CSP lets it talk to the API
# and nothing else. A pull request's preview is the prefix pr-<n>/ of the same
# bucket. TLS terminates at CloudFront with an ACM certificate from us-east-1.

data "aws_caller_identity" "current" {}

locals {
  name        = "${var.project}-${var.environment}"
  account_id  = data.aws_caller_identity.current.account_id
  bucket_name = "${var.project}-admin-${var.environment}-${local.account_id}"
  # preview.yml writes the panel built under /pr-<n>/ here, and the plan role
  # may write nothing else (infra/bootstrap, ci_plan_admin_previews).
  preview_prefix = "pr-"
}

# ---------------------------------------------------------------------------
# The bucket. Private; the only reader is the distribution (origin access
# control). CI writes it: main's build at the root, a pull request's preview
# under pr-<n>/ (ADR-025 §5-§7). Versioning stays off: every object is the
# build of a commit, and CI rebuilds it.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "admin" {
  bucket = local.bucket_name

  tags = { Name = local.bucket_name }
}

resource "aws_s3_bucket_public_access_block" "admin" {
  bucket = aws_s3_bucket.admin.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "admin" {
  bucket = aws_s3_bucket.admin.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "admin" {
  bucket = aws_s3_bucket.admin.id

  # SSE-S3; a bucket key is an SSE-KMS construct and has no place here.
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "admin" {
  bucket = aws_s3_bucket.admin.id

  versioning_configuration {
    status = "Disabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "admin" {
  bucket = aws_s3_bucket.admin.id

  # CI uploads whole files; a multipart upload left behind by a cancelled job is garbage after a day.
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  # The backstop to the sweep (ADR-025 §8): preview-cleanup.yml removes pr-<n>/
  # with the pull request's other previews, never waiting for a person, and
  # never blocking the rest on a failure here (ADR-012 §4). What it leaves
  # expires after the sweep's seven days, with room.
  rule {
    id     = "expire-previews"
    status = "Enabled"

    filter {
      prefix = local.preview_prefix
    }

    expiration {
      days = 14
    }
  }
}

# ---------------------------------------------------------------------------
# How the distribution reads and answers: origin access control, the managed
# cache policy, the panel's headers, and the previews' function.
# ---------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "admin" {
  name                              = "${local.name}-admin"
  description                       = "The distribution reads the panel's bucket; nothing else does"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CI says how long each file lives (ADR-025 §4): index.html no-cache, the
# hashed assets public and immutable for a year, and main's deploy invalidates
# /* after the sync. The managed policy honours both and compresses.
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

# The panel's headers (ADR-025 §3), on every behaviour: the website's house set
# (kuutti-app-site) plus what a script needs. The API's origin is the only
# place the panel talks to and the name the signed photo URLs are on
# (ADR-005); no third party, no inline script or style, and the panel's forms
# all prevent their default. Override throughout, so this policy is the one
# source of these headers.
resource "aws_cloudfront_response_headers_policy" "admin" {
  name    = "${local.name}-admin"
  comment = "The moderation panel's headers (ADR-025)"

  security_headers_config {
    content_security_policy {
      content_security_policy = join("; ", [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' ${var.api_origin}",
        "connect-src ${var.api_origin}",
        # No service worker: one registered from a preview's prefix could take
        # the whole origin, the root's panel and its bank return included, and
        # outlive the preview (ADR-025 §3).
        "worker-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ])
      override = true
    }

    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }

    content_type_options {
      override = true
    }

    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=()"
      override = true
    }

    items {
      header   = "Cross-Origin-Opener-Policy"
      value    = "same-origin"
      override = true
    }

    items {
      header   = "Cross-Origin-Resource-Policy"
      value    = "same-origin"
      override = true
    }

    # As the API sends it (apps/api/src/app.ts).
    items {
      header   = "X-Robots-Tag"
      value    = "noindex, nofollow"
      override = true
    }
  }
}

# Previews (ADR-025 §6): a page inside pr-<n>/ is that preview's index.html.
# Without it every preview path would fall into the fallback below and get
# main's panel. On the pr-* behaviour alone; the repository's first CloudFront
# Function, and Lambda@Edge stays out (rules/infra.md).
resource "aws_cloudfront_function" "previews" {
  name    = "${local.name}-admin-previews"
  runtime = "cloudfront-js-2.0"
  comment = "A page inside a panel preview is that preview's index.html (ADR-025)"
  publish = true
  code    = file("${path.module}/previews.js")
}

# ---------------------------------------------------------------------------
# The certificate for the alias, in us-east-1 as CloudFront requires, validated
# by a record in the project zone.
# ---------------------------------------------------------------------------

resource "aws_acm_certificate" "admin" {
  provider = aws.us_east_1

  domain_name       = var.admin_fqdn
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = var.admin_fqdn }
}

resource "aws_route53_record" "validation" {
  for_each = {
    for dvo in aws_acm_certificate.admin.domain_validation_options : dvo.domain_name => {
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

resource "aws_acm_certificate_validation" "admin" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.admin.arn
  validation_record_fqdns = [for record in aws_route53_record.validation : record.fqdn]
}

# ---------------------------------------------------------------------------
# The distribution.
# ---------------------------------------------------------------------------

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${local.name}: the moderation panel (ADR-025)"
  http_version    = "http2and3"
  # Europe and North America, as the API's distribution (modules/media).
  price_class         = "PriceClass_100"
  aliases             = [var.admin_fqdn]
  default_root_object = "index.html"

  origin {
    origin_id                = "panel"
    domain_name              = aws_s3_bucket.admin.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.admin.id
  }

  default_cache_behavior {
    target_origin_id           = "panel"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.admin.id
    compress                   = true
  }

  ordered_cache_behavior {
    path_pattern               = "${local.preview_prefix}*"
    target_origin_id           = "panel"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.admin.id
    compress                   = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.previews.arn
    }
  }

  # A path is the app (ADR-025 §2, #302): the bucket answers 403 for a key it
  # does not have, since CloudFront may not list it, so /accounts/<id> gets
  # index.html and the router finds the page; 404 the same, should it ever be
  # allowed to list. The answer is cached for ten seconds (CloudFront's default,
  # stated because it matters): a preview published under a path asked for a
  # moment earlier is seen within them.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.admin.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = { Name = "${local.name}-admin" }
}

# Only this distribution reads the bucket.
data "aws_iam_policy_document" "bucket" {
  statement {
    sid       = "CloudFrontRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.admin.arn}/*"]

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

resource "aws_s3_bucket_policy" "admin" {
  bucket = aws_s3_bucket.admin.id
  policy = data.aws_iam_policy_document.bucket.json

  depends_on = [aws_s3_bucket_public_access_block.admin]
}

# admin.<env>.<domain> is the distribution; nothing else answers to it.
resource "aws_route53_record" "admin" {
  for_each = toset(["A", "AAAA"])

  zone_id = var.zone_id
  name    = var.admin_fqdn
  type    = each.key

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}
