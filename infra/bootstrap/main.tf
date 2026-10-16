data "aws_caller_identity" "current" {}

locals {
  account_id  = data.aws_caller_identity.current.account_id
  bucket_name = "${var.project}-tfstate-${local.account_id}"
  iam_path    = "/${var.project}/"

  # With immutable subject claims the sub is
  #   repo:<owner>@<owner_id>/<repo>@<repo_id>:<context>
  # The repository_id and repository_owner_id conditions below pin the owner and
  # the repo. The IDs are repeated inside the patterns so the roles stay bound to
  # this repository even if someone later removes those conditions.
  sub_prefix       = "repo:*@${var.github_owner_id}/*@${var.github_repository_id}"
  sub_pull_request = "${local.sub_prefix}:pull_request"
  sub_main_branch  = "${local.sub_prefix}:ref:refs/heads/main"
  sub_environments = [for e in var.deploy_environments : "${local.sub_prefix}:environment:${e}"]
}

# ---------------------------------------------------------------------------
# State bucket. Holds secrets, so it is treated as a secret store.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "state" {
  bucket = local.bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Old state versions are kept for a year, then expire. Keeps the bucket from
# growing without bound while leaving a usable recovery window.
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 365
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # Weekly GitHub exports (#16 D.2): a year of them is a long enough memory. A
  # replaced version lives as long, so an overwrite never outlasts the original;
  # more than one version under a date is a sign of tampering (infra/README.md).
  rule {
    id     = "expire-github-exports"
    status = "Enabled"

    filter {
      prefix = "github-export/"
    }

    expiration {
      days = 365
    }

    noncurrent_version_expiration {
      noncurrent_days = 365
    }
  }

  # Nightly Dokploy backups from the API boxes (#7) land under this prefix;
  # ninety days is plenty for a rebuild and keeps the bucket bounded.
  rule {
    id     = "expire-dokploy-backups"
    status = "Enabled"

    filter {
      prefix = "dokploy-backup/"
    }

    expiration {
      days = 90
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

resource "aws_s3_bucket_policy" "state_tls_only" {
  bucket = aws_s3_bucket.state.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        aws_s3_bucket.state.arn,
        "${aws_s3_bucket.state.arn}/*",
      ]
      Condition = {
        Bool = { "aws:SecureTransport" = "false" }
      }
    }]
  })
}

# ---------------------------------------------------------------------------
# GitHub Actions OIDC. No static AWS keys exist anywhere in CI.
# ---------------------------------------------------------------------------

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  # thumbprint_list is deliberately omitted. AWS validates GitHub's OIDC
  # certificate against its own trusted CA library and ignores the list for this
  # provider, so maintaining a thumbprint here would be pure ceremony.
}

data "aws_iam_policy_document" "github_assume_plan" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository_id"
      values   = [var.github_repository_id]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository_owner_id"
      values   = [var.github_owner_id]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.sub_pull_request, local.sub_main_branch]
    }
  }
}

data "aws_iam_policy_document" "github_assume_apply" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository_id"
      values   = [var.github_repository_id]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository_owner_id"
      values   = [var.github_owner_id]
    }

    # Environment context only. Production applies therefore inherit the
    # approval requirement configured on the GitHub environment.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.sub_environments
    }
  }
}

# ---------------------------------------------------------------------------
# CI roles: plan is read-only, apply can change things.
# ---------------------------------------------------------------------------

# Native S3 locking writes and removes a <key>.tflock object next to the state,
# so even plan must create and delete lock objects. It never writes state.
data "aws_iam_policy_document" "state_read" {
  statement {
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketVersioning"]
    resources = [aws_s3_bucket.state.arn]
  }

  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.state.arn}/*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.state.arn}/*.tflock"]
  }
}

data "aws_iam_policy_document" "state_write" {
  statement {
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketVersioning"]
    resources = [aws_s3_bucket.state.arn]
  }

  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.state.arn}/*"]
  }
}

# ReadOnlyAccess is broader than its name: it includes ssm:Get*, s3:Get* and
# logs:Get*, and under the default aws/ssm KMS key that is enough to decrypt
# every SecureString parameter. The plan role is assumable from any pull
# request, so data access is explicitly denied here; an explicit deny beats the
# managed allow. Plan needs resource metadata and the state bucket, nothing else.
data "aws_iam_policy_document" "ci_plan_deny_data" {
  statement {
    effect = "Deny"
    actions = [
      "kms:Decrypt",
      "secretsmanager:GetSecretValue",
      "logs:GetLogEvents",
      "logs:FilterLogEvents",
      "logs:StartQuery",
      "logs:GetQueryResults",
      "rds:DownloadDBLogFilePortion",
      "rds:DownloadCompleteDBLogFile",
    ]
    resources = ["*"]
  }

  statement {
    effect        = "Deny"
    actions       = ["s3:GetObject", "s3:GetObjectVersion"]
    not_resources = ["${aws_s3_bucket.state.arn}/*"]
  }
}

resource "aws_iam_role" "ci_plan" {
  name                 = "${var.project}-ci-plan"
  path                 = local.iam_path
  assume_role_policy   = data.aws_iam_policy_document.github_assume_plan.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "ci_plan_readonly" {
  role       = aws_iam_role.ci_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy" "ci_plan_state" {
  name   = "state-read"
  role   = aws_iam_role.ci_plan.id
  policy = data.aws_iam_policy_document.state_read.json
}

resource "aws_iam_role_policy" "ci_plan_deny_data" {
  name   = "deny-data-access"
  role   = aws_iam_role.ci_plan.id
  policy = data.aws_iam_policy_document.ci_plan_deny_data.json
}

# Pull-request previews (#9): preview-cleanup.yml drops kuutti_pr_<n> on the
# staging box through the one Run Command document envs/staging declares
# (modules/compute). The plan role, assumable from any pull request, may send
# exactly that document to exactly that box and nothing else; the document
# validates its one parameter, so the most a pull request can do is drop
# another pull request's preview database. Both halves are needed: SendCommand
# is authorised against the document and against the instance.
data "aws_iam_policy_document" "ci_plan_preview_cleanup" {
  statement {
    sid       = "PreviewDatabaseDocument"
    effect    = "Allow"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ssm:${var.region}:${local.account_id}:document/${var.project}-staging-preview-database"]
  }

  statement {
    sid       = "StagingBoxOnly"
    effect    = "Allow"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ec2:${var.region}:${local.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/Name"
      values   = ["${var.project}-staging"]
    }
  }
}

# The moderation panel's previews (#313, ADR-025 §6-§8): preview.yml writes a
# pull request's build under pr-<n>/ of staging's panel bucket (modules/admin),
# and preview-cleanup.yml removes it, both from jobs without an environment and
# so as this role; the bucket's root is kuutti-ci-apply's, from the staging
# environment. Listing comes with ReadOnlyAccess and reading objects stays
# denied (ci_plan_deny_data), so the most a pull request can do is replace or
# remove another pull request's panel preview, which runs on the staging
# panel's origin just as its own preview does. The bucket is named by the
# module's convention, as the document above is by compute's.
data "aws_iam_policy_document" "ci_plan_admin_previews" {
  statement {
    sid       = "AdminPreviewObjects"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${var.project}-admin-staging-${local.account_id}/pr-*"]
  }
}

# The weekly export of what exists only on GitHub (#16 D.2, export.yml) has a
# role of its own. The plan role is assumable from any pull request, and a
# pull request that could write under github-export/ could replace the bundle
# a recovery would restore from. This role trusts the main branch only, may put
# objects under that one prefix and nothing else, and cannot delete them; the
# bucket is versioned, and the lifecycle rule keeps replaced versions as long
# as the exports themselves.
data "aws_iam_policy_document" "github_assume_export" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository_id"
      values   = [var.github_repository_id]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository_owner_id"
      values   = [var.github_owner_id]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.sub_main_branch]
    }
  }
}

data "aws_iam_policy_document" "ci_export" {
  statement {
    sid       = "GithubExportPrefixOnly"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.state.arn}/github-export/*"]
  }
}

resource "aws_iam_role" "ci_export" {
  name                 = "${var.project}-ci-export"
  path                 = local.iam_path
  assume_role_policy   = data.aws_iam_policy_document.github_assume_export.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "ci_export" {
  name   = "github-export"
  role   = aws_iam_role.ci_export.id
  policy = data.aws_iam_policy_document.ci_export.json
}

resource "aws_iam_role_policy" "ci_plan_preview_cleanup" {
  name   = "preview-cleanup"
  role   = aws_iam_role.ci_plan.id
  policy = data.aws_iam_policy_document.ci_plan_preview_cleanup.json
}

resource "aws_iam_role_policy" "ci_plan_admin_previews" {
  name   = "admin-previews"
  role   = aws_iam_role.ci_plan.id
  policy = data.aws_iam_policy_document.ci_plan_admin_previews.json
}

resource "aws_iam_role" "ci_apply" {
  name                 = "${var.project}-ci-apply"
  path                 = local.iam_path
  assume_role_policy   = data.aws_iam_policy_document.github_assume_apply.json
  max_session_duration = 3600
}

# PowerUserAccess covers every service this stack uses but excludes IAM, so the
# scoped policy below adds back only what is needed to manage this project's own
# roles and policies. Deliberately not AdministratorAccess.
resource "aws_iam_role_policy_attachment" "ci_apply_poweruser" {
  role       = aws_iam_role.ci_apply.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

# Permissions boundary for every role the apply role creates. Without it the
# apply role could create a role that trusts it, attach AdministratorAccess, and
# assume it. The boundary has the same shape as PowerUserAccess, so a bounded
# role can never do more than the apply role itself. Every role in infra/modules
# must set permissions_boundary to this policy; the apply role's IAM permissions
# below refuse to create or modify a role without it.
data "aws_iam_policy_document" "boundary" {
  statement {
    effect      = "Allow"
    not_actions = ["iam:*", "organizations:*", "account:*"]
    resources   = ["*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "iam:CreateServiceLinkedRole",
      "iam:DeleteServiceLinkedRole",
      "iam:ListRoles",
      "organizations:DescribeOrganization",
      "account:ListRegions",
      "account:GetAccountInformation",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "boundary" {
  name   = "${var.project}-boundary"
  path   = local.iam_path
  policy = data.aws_iam_policy_document.boundary.json
}

data "aws_iam_policy_document" "ci_apply_iam" {
  # Creating a role or changing its policies is allowed only for roles that
  # carry the boundary.
  statement {
    effect = "Allow"
    actions = [
      "iam:CreateRole",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePermissionsBoundary",
    ]
    resources = ["arn:aws:iam::${local.account_id}:role${local.iam_path}*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.boundary.arn]
    }
  }

  statement {
    effect = "Allow"
    actions = [
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:UpdateRole",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:ListAttachedRolePolicies",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:CreateInstanceProfile",
      "iam:DeleteInstanceProfile",
      "iam:GetInstanceProfile",
      "iam:TagInstanceProfile",
      "iam:UntagInstanceProfile",
      "iam:AddRoleToInstanceProfile",
      "iam:RemoveRoleFromInstanceProfile",
    ]
    resources = [
      "arn:aws:iam::${local.account_id}:role${local.iam_path}*",
      "arn:aws:iam::${local.account_id}:instance-profile${local.iam_path}*",
    ]
  }

  # List calls are not resource-scoped.
  statement {
    effect    = "Allow"
    actions   = ["iam:ListRoles", "iam:ListPolicies", "iam:ListInstanceProfiles"]
    resources = ["*"]
  }

  # Roles may be handed only to the services that run this stack.
  statement {
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${local.account_id}:role${local.iam_path}*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com", "monitoring.rds.amazonaws.com"]
    }
  }

  statement {
    effect = "Allow"
    actions = [
      "iam:CreatePolicy",
      "iam:DeletePolicy",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
    ]
    resources = ["arn:aws:iam::${local.account_id}:policy${local.iam_path}*"]
  }

  # Service-linked roles for RDS, SES and friends.
  statement {
    effect    = "Allow"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["*"]
  }

  # The apply role must not be able to rewrite its own trust policy or that of
  # the plan role, nor change the boundary policy itself.
  statement {
    effect = "Deny"
    actions = [
      "iam:UpdateAssumeRolePolicy",
      "iam:DeleteRole",
      "iam:PutRolePolicy",
      "iam:AttachRolePolicy",
      "iam:PutRolePermissionsBoundary",
    ]
    resources = [
      aws_iam_role.ci_plan.arn,
      "arn:aws:iam::${local.account_id}:role${local.iam_path}${var.project}-ci-apply",
    ]
  }

  statement {
    effect = "Deny"
    actions = [
      "iam:DeletePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:SetDefaultPolicyVersion",
    ]
    resources = [aws_iam_policy.boundary.arn]
  }

  # No role under the project path may lose its boundary.
  statement {
    effect    = "Deny"
    actions   = ["iam:DeleteRolePermissionsBoundary"]
    resources = ["arn:aws:iam::${local.account_id}:role${local.iam_path}*"]
  }
}

resource "aws_iam_role_policy" "ci_apply_iam" {
  name   = "iam-scoped"
  role   = aws_iam_role.ci_apply.id
  policy = data.aws_iam_policy_document.ci_apply_iam.json
}

resource "aws_iam_role_policy" "ci_apply_state" {
  name   = "state-write"
  role   = aws_iam_role.ci_apply.id
  policy = data.aws_iam_policy_document.state_write.json
}
