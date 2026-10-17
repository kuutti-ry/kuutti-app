# The research copy (#194, ADR-029 §9 to §11, TD-5): the API's nightly job
# writes one Parquet file a day under research/ of the environment's media
# bucket (apps/api/src/research/copy-store.ts). This module gives the API the
# right to write each file once and read the files back, gives the research
# partner a read-only role on that prefix and nothing else, and logs every
# object call under it into a bucket of its own. The lifecycle rule that
# moves the files to Glacier Instant Retrieval after a year is the media
# module's, since a bucket has one lifecycle configuration.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name       = "${var.project}-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  iam_path   = "/${var.project}/"
  objects    = "${var.bucket_arn}/${var.prefix}*"

  # The Identity Center permission set whose role may assume the researcher's
  # role here, one per environment (KuuttiResearchStaging, KuuttiResearchProd):
  # an assignment of staging's opens nothing in production, by the trust
  # itself and not only by the permission set's own policy.
  permission_set = "KuuttiResearch${title(var.environment)}"

  log_bucket = "${var.project}-research-access-${var.environment}-${local.account_id}"
  trail_name = "${local.name}-research-access"
  # Built from the name: the log bucket's policy names the trail, and the
  # trail cannot be created before that policy exists.
  trail_arn = "arn:aws:cloudtrail:${data.aws_region.current.region}:${local.account_id}:trail/${local.trail_name}"
  # How long the access log is kept: five years, the maintainer's to confirm (ADR-029).
  log_days = 1825
}

# ---------------------------------------------------------------------------
# The API (the instance role): a day's file is written once and never
# replaced or removed (ADR-029 §5, §9). S3 accepts a put under research/ only
# with If-None-Match, so an existing file answers 412 and stands; the API
# sends nothing else (no multipart upload, so no exemption for one). It reads
# the files of the previous ninety days for the census (ADR-029 §4). There is
# no delete: a day is fixed forward with a new format version, never redone.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "api" {
  statement {
    sid       = "ResearchWriteOnce"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = [local.objects]

    # Only a put that says If-None-Match: * (ADR-029 §9). That S3 hands this
    # key to an identity policy at all is shown by the first night's write,
    # not by a simulation: written >= 1 in the job's line is the proof, and
    # AccessDenied on every put points here first (infra/README.md).
    condition {
      test     = "StringEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }

  statement {
    sid       = "ResearchRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = [local.objects]
  }

  statement {
    sid       = "ResearchList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [var.bucket_arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${var.prefix}*"]
    }
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "research-objects"
  role   = var.instance_role_name
  policy = data.aws_iam_policy_document.api.json
}

# ---------------------------------------------------------------------------
# The researcher's role (ADR-029 §10): list and read research/ of this
# environment's bucket, nothing else; no media/, no put, no delete. Sessions
# last an hour, the most a chained role session gets anyway.
#
# The trust names this account and lets in only the role Identity Center
# provisions for the permission set above (AWSReservedSSO_<set>_<suffix>,
# under /aws-reserved/sso.amazonaws.com/ with or without a region segment):
# one pattern for each path, with no wildcard before the name. The suffix is
# a wildcard, so a set named <set>_<anything> would pass as well; only the
# maintainer creates sets, and matching the suffix exactly waits for a
# provisioned role's ARN to show its length (ADR-029 §10). Who the
# researcher is, is therefore the Identity Center assignment, made and removed
# by the maintainer (infra/README.md, Research copy), and the trust never has
# to change: the apply role cannot update a trust policy (bootstrap,
# ci_apply_iam), so a change to it fails in CI and is the maintainer's own
# apply. The account root as principal means the caller's own policy must
# allow sts:AssumeRole too, which the permission set's inline policy does for
# this role alone. The trust survives the account's move under the
# association's organisation (ADR-001), as long as the permission set there
# keeps its name.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "reader_trust" {
  statement {
    sid     = "IdentityCenterPermissionSet"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:PrincipalArn"
      values = [
        "arn:aws:iam::${local.account_id}:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_${local.permission_set}_*",
        "arn:aws:iam::${local.account_id}:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_${local.permission_set}_*",
      ]
    }
  }
}

resource "aws_iam_role" "reader" {
  name                 = "${local.name}-research-read"
  path                 = local.iam_path
  assume_role_policy   = data.aws_iam_policy_document.reader_trust.json
  permissions_boundary = var.permissions_boundary_arn
  max_session_duration = 3600
  description          = "The research partner's read-only access to research/ of the ${var.environment} media bucket (#194, ADR-029)."
}

data "aws_iam_policy_document" "reader" {
  statement {
    sid       = "ResearchList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [var.bucket_arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${var.prefix}*"]
    }
  }

  statement {
    sid       = "ResearchRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = [local.objects]
  }
}

resource "aws_iam_role_policy" "reader" {
  name   = "research-read"
  role   = aws_iam_role.reader.id
  policy = data.aws_iam_policy_document.reader.json
}

# ---------------------------------------------------------------------------
# Every object call under research/ logged (ADR-029 §11): a single-region
# trail of S3 data events, the object-level calls (GetObject, HeadObject,
# PutObject and the refused attempts at them) whose key starts with
# research/, and no management events. It records the researcher's reads
# with the role session's name and the API's nightly writes and census reads,
# a hundred or so events a night. Log-file validation chains a signed digest
# every hour, so a removed or altered log file shows (aws cloudtrail
# validate-logs).
#
# Not S3 server access logs: they are per bucket, so they would log every
# CloudFront fetch of a photo as well, and AWS delivers them on a best-effort
# basis. Not CloudWatch Logs either: the trail would need a role passed to
# cloudtrail.amazonaws.com, which the apply role may not pass.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "access_log" {
  bucket = local.log_bucket

  tags = { Name = local.log_bucket }
}

resource "aws_s3_bucket_public_access_block" "access_log" {
  bucket = aws_s3_bucket.access_log.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "access_log" {
  bucket = aws_s3_bucket.access_log.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "access_log" {
  bucket = aws_s3_bucket.access_log.id

  # SSE-S3, as the media bucket; CloudTrail writes with it unless given a KMS key.
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Versioned, so a log file overwritten or deleted by hand is still there as
# an older version, and the digests say which.
resource "aws_s3_bucket_versioning" "access_log" {
  bucket = aws_s3_bucket.access_log.id

  versioning_configuration {
    status = "Enabled"
  }
}

# A replaced version lives as long as the log itself, so an overwrite never
# outlasts the original (the state bucket's rule for the GitHub exports).
resource "aws_s3_bucket_lifecycle_configuration" "access_log" {
  bucket = aws_s3_bucket.access_log.id

  rule {
    id     = "expire-access-log"
    status = "Enabled"

    filter {}

    expiration {
      days = local.log_days
    }

    noncurrent_version_expiration {
      noncurrent_days = local.log_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.access_log]
}

# CloudTrail may check the bucket and write under AWSLogs/<account>/, for
# this trail only.
data "aws_iam_policy_document" "access_log" {
  statement {
    sid       = "CloudTrailAclCheck"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.access_log.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }

  statement {
    sid       = "CloudTrailWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.access_log.arn}/AWSLogs/${local.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "access_log" {
  bucket = aws_s3_bucket.access_log.id
  policy = data.aws_iam_policy_document.access_log.json

  depends_on = [aws_s3_bucket_public_access_block.access_log]
}

resource "aws_cloudtrail" "research" {
  name                          = local.trail_name
  s3_bucket_name                = aws_s3_bucket.access_log.id
  is_multi_region_trail         = false
  include_global_service_events = false
  enable_log_file_validation    = true

  # With advanced selectors a trail logs only what they select: these data
  # events, and no management events.
  advanced_event_selector {
    name = "Object calls under ${var.prefix}"

    field_selector {
      field  = "eventCategory"
      equals = ["Data"]
    }

    field_selector {
      field  = "resources.type"
      equals = ["AWS::S3::Object"]
    }

    field_selector {
      field       = "resources.ARN"
      starts_with = ["${var.bucket_arn}/${var.prefix}"]
    }
  }

  depends_on = [aws_s3_bucket_policy.access_log]
}
