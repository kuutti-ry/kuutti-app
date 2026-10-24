# The one API box per environment (TD-4, project context §2): t4g.small, Ubuntu
# 24.04 arm64, an Elastic IP, and an instance role that reaches exactly its own
# SSM prefix, its own log group and its backup prefix (TD-19, TD-4 access rule).
# The bucket (modules/media, #48) and Rekognition (#49) arrived with M3, SES
# sending with #385 (ADR-043 §5), the box's swap and its free-memory metric
# with #77 (ADR-046).

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# Canonical publishes the current AMI id as a public parameter; resolving it at
# plan time and ignoring later changes (lifecycle below) means a new image never
# silently replaces the box. Rebuild deliberately with `tofu apply -replace`.
data "aws_ssm_parameter" "ubuntu_arm64" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

locals {
  name              = "${var.project}-${var.environment}"
  region            = data.aws_region.current.region
  account_id        = data.aws_caller_identity.current.account_id
  iam_path          = "/${var.project}/"
  ssm_prefix        = "/${var.project}/${var.environment}/"
  log_group_name    = "/${var.project}/${var.environment}/api"
  session_log_group = "/${var.project}/ssm-sessions"
  backup_prefix     = "dokploy-backup/${var.environment}/"
  # The API's MAIL_FROM default (apps/api/src/lib/config.ts) without its
  # display name, which ses:FromAddress does not include.
  mail_from = "noreply@${var.domain}"
  # Where the box's free memory goes, which modules/observability's
  # memory-low alarm reads (#77). A namespace of its own, not Kuutti/<env>:
  # the box may write here and nowhere else, so nothing on it (the API, a
  # preview) can push into the log filters' metrics and quiet their alarms.
  metric_namespace = "Kuutti/${var.environment}/box"
  # One text for first boot (user_data) and for a running box (the Run
  # Command document below), #77, ADR-046.
  headroom = templatefile("${path.module}/templates/headroom.sh.tpl", {
    region    = local.region
    namespace = local.metric_namespace
    swap_mb   = var.swap_mb
  })
}

# ---------------------------------------------------------------------------
# Logs. Every container on the box logs here through the awslogs driver, one
# stream per container name; 30 days is the retention rules/infra.md sets.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "api" {
  name              = local.log_group_name
  retention_in_days = 30
}

# ---------------------------------------------------------------------------
# Instance role. Bounded by the bootstrap policy (ADR-001), scoped to this
# environment: the staging role cannot read /kuutti/prod/* and vice versa.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "api" {
  # Configuration and secrets at boot (TD-19). Both ARN shapes are needed:
  # GetParametersByPath is evaluated against the path, GetParameter against
  # the parameter.
  statement {
    sid     = "OwnParameters"
    effect  = "Allow"
    actions = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = [
      "arn:aws:ssm:${local.region}:${local.account_id}:parameter${trimsuffix(local.ssm_prefix, "/")}",
      "arn:aws:ssm:${local.region}:${local.account_id}:parameter${local.ssm_prefix}*",
    ]
  }

  # AmazonSSMManagedInstanceCore (attached below for Session Manager) allows
  # ssm:GetParameter and ssm:GetParameters on every parameter in the account,
  # which would let this box read the other environment's secrets. An explicit
  # deny outside the own prefix wins over that allow; nothing the agent does
  # here reads parameters, so it loses nothing.
  statement {
    sid    = "NoOtherParameters"
    effect = "Deny"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
      "ssm:GetParameterHistory",
    ]
    not_resources = [
      "arn:aws:ssm:${local.region}:${local.account_id}:parameter${trimsuffix(local.ssm_prefix, "/")}",
      "arn:aws:ssm:${local.region}:${local.account_id}:parameter${local.ssm_prefix}*",
    ]
  }

  # SecureStrings under the default aws/ssm key, and SSE-KMS objects in S3.
  # ViaService keeps this to those two uses; the AWS-managed keys are created
  # lazily by AWS, so they are not looked up here.
  statement {
    sid       = "KmsThroughSsmAndS3"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${local.region}.amazonaws.com", "s3.${local.region}.amazonaws.com"]
    }
  }

  # Photo moderation (#49, ADR-006) and tip signals (#56): the three detect
  # calls and nothing else of Rekognition. Detect actions take no resource,
  # hence "*"; the images are bytes in the request and nothing is stored on
  # the Rekognition side.
  statement {
    sid    = "RekognitionDetect"
    effect = "Allow"
    actions = [
      "rekognition:DetectModerationLabels",
      "rekognition:DetectFaces",
      "rekognition:DetectLabels",
    ]
    resources = ["*"]
  }

  # Mail (#385, ADR-043 §5): the code that confirms an address. SESv2
  # SendEmail with simple content is authorised as ses:SendEmail against the
  # sending identity, so neither ses:SendRawEmail nor a configuration set is
  # granted. The identity is the domain's (infra/bootstrap/mail.tf, in this
  # region, the API's S3_REGION), and the From address is pinned to noreply@:
  # a MAIL_FROM of any other address is refused here, and the API answers 503.
  # On staging a pull request's preview runs under this role too (ADR-004 §3).
  # Staging also names whom it may mail (#385, ADR-043 §6): every account there
  # is one of Telia's test persons, whose credentials are published, so without
  # the list anyone could have codes sent to addresses of their choosing once
  # SES leaves the sandbox, signed as kuutti.app from the account and region
  # production shares, and the complaints would reach production's reputation
  # and suppression list. Production passes null: its accounts are people the
  # bank verified. A recipient outside the list is AccessDenied, answered 503.
  statement {
    sid       = "SesSendAsNoreply"
    effect    = "Allow"
    actions   = ["ses:SendEmail"]
    resources = ["arn:aws:ses:${local.region}:${local.account_id}:identity/${var.domain}"]

    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [local.mail_from]
    }

    dynamic "condition" {
      for_each = var.mail_recipients == null ? [] : [var.mail_recipients]
      content {
        test     = "ForAllValues:StringLike"
        variable = "ses:Recipients"
        values   = condition.value
      }
    }
  }

  statement {
    sid    = "OwnLogGroup"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = [
      "${aws_cloudwatch_log_group.api.arn}:*",
      "arn:aws:logs:${local.region}:${local.account_id}:log-group:${local.session_log_group}:*",
    ]
  }

  # The box's free memory, once a minute (#77, ADR-046), into this
  # environment's namespace alone. PutMetricData takes no resource; the
  # namespace is its one condition key.
  statement {
    sid       = "OwnMetrics"
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [local.metric_namespace]
    }
  }

  # The agent checks the session log group exists before it streams to it.
  statement {
    sid       = "DescribeLogGroups"
    effect    = "Allow"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  # Nightly Dokploy backup. SSE-KMS is required so the objects stay unreadable
  # to the plan role, which may read the state bucket but is explicitly denied
  # kms:Decrypt (bootstrap). The box may read its own backups back for a
  # rebuild (README); it can never delete them or touch state.
  statement {
    sid       = "DokployBackupWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::${var.backup_bucket}/${local.backup_prefix}*"]

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid       = "DokployBackupRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${var.backup_bucket}/${local.backup_prefix}*"]
  }

  statement {
    sid       = "DokployBackupList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.backup_bucket}"]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.backup_prefix}*"]
    }
  }
}

resource "aws_iam_role" "api" {
  name                 = "${var.project}-api-${var.environment}"
  path                 = local.iam_path
  assume_role_policy   = data.aws_iam_policy_document.assume_ec2.json
  permissions_boundary = var.permissions_boundary_arn
  description          = "Instance role of the ${var.environment} API box: its own SSM prefix, log group and backup prefix."
}

resource "aws_iam_role_policy" "api" {
  name   = "own-resources"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

# Session Manager instead of SSH keys.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "api" {
  name = aws_iam_role.api.name
  path = local.iam_path
  role = aws_iam_role.api.name
}

# ---------------------------------------------------------------------------
# Session Manager logging, account-wide, declared once (see the variable).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "ssm_sessions" {
  count = var.manage_session_preferences ? 1 : 0

  name              = local.session_log_group
  retention_in_days = 90
}

resource "aws_ssm_document" "session_preferences" {
  count = var.manage_session_preferences ? 1 : 0

  name            = "SSM-SessionManagerRunShell"
  document_type   = "Session"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "1.0"
    description   = "Session Manager preferences: every shell is streamed to CloudWatch Logs (#7)."
    sessionType   = "Standard_Stream"
    inputs = {
      cloudWatchLogGroupName      = aws_cloudwatch_log_group.ssm_sessions[0].name
      cloudWatchEncryptionEnabled = false
      cloudWatchStreamingEnabled  = true
      idleSessionTimeout          = "20"
      maxSessionDuration          = "120"
      runAsEnabled                = false
      # Sessions run as ssm-user; `sudo -i` for root. Every keystroke and
      # every line of output is streamed, so never echo a secret in one.
      shellProfile = {
        linux = "bash"
      }
    }
  })
}

# ---------------------------------------------------------------------------
# Pull-request preview databases (#9, TD-19), staging only. The preview API
# creates kuutti_pr_<n> itself at boot; dropping it when the pull request
# closes is this Run Command document, sent by preview-cleanup.yml through the
# plan role, which the bootstrap allows to send exactly this document to
# exactly this box. The one parameter is validated here, so the most a pull
# request can do is drop another pull request's preview database. Runs as root
# on the box with the instance role, which reads only its own SSM prefix, and
# connects as the preview role, which owns every kuutti_pr_<n> and nothing else.
# ---------------------------------------------------------------------------

resource "aws_ssm_document" "preview_database" {
  count = var.preview_databases ? 1 : 0

  name            = "${local.name}-preview-database"
  document_type   = "Command"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Drops the pull-request preview database ${var.project}_pr_<prNumber> on ${local.name} (#9). Sent by preview-cleanup.yml."
    parameters = {
      prNumber = {
        type           = "String"
        description    = "Pull request number"
        allowedPattern = "^[0-9]{1,7}$"
      }
    }
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "dropPreviewDatabase"
      inputs = {
        timeoutSeconds = "120"
        # The password stays in the shell: nothing here echoes it, and the
        # invocation output that CI prints is psql's one line.
        runCommand = [
          # The agent runs these lines with sh (dash), which has no pipefail; nothing here pipes.
          "set -eu",
          "export PATH=\"$PATH:/snap/bin\"",
          "n='{{ prNumber }}'",
          "host=$(aws ssm get-parameter --region ${local.region} --name ${local.ssm_prefix}db-host --query Parameter.Value --output text)",
          # Two lines: `export X=$(cmd)` returns export's status and would hide a failed fetch from set -e.
          "PGPASSWORD=$(aws ssm get-parameter --region ${local.region} --name ${local.ssm_prefix}db-preview-password --with-decryption --query Parameter.Value --output text)",
          "export PGPASSWORD",
          "psql \"host=$host dbname=postgres user=${var.project}_preview sslmode=verify-full sslrootcert=/etc/kuutti/rds-ca.pem\" -v ON_ERROR_STOP=1 -c \"DROP DATABASE IF EXISTS ${var.project}_pr_$n WITH (FORCE)\"",
          "echo \"dropped ${var.project}_pr_$n\"",
        ]
      }
    }]
  })
}

# ---------------------------------------------------------------------------
# Headroom on a running box (#77, ADR-046). user_data gives a new box its
# swap and the free-memory metric at first boot, and
# ignore_changes keeps a running box from ever seeing an edit of it. So the
# maintainer sends this document, the same text, to a box that predates the
# change, and again after a change of swap_mb
# (infra/README.md, The box's headroom). A second run changes nothing.
# Nothing in CI sends it.
# ---------------------------------------------------------------------------

resource "aws_ssm_document" "headroom" {
  name            = "${local.name}-headroom"
  document_type   = "Command"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Swap and the free-memory metric on ${local.name} (#77). Sent by the maintainer; a second run changes nothing."
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "headroom"
      inputs = {
        timeoutSeconds = "600"
        runCommand     = split("\n", local.headroom)
      }
    }]
  })

  lifecycle {
    # Run Command reads {{ name }} in a document as its parameter; this one
    # has none, so a brace pair in the script would break the document.
    precondition {
      condition     = !strcontains(local.headroom, "{{")
      error_message = "templates/headroom.sh.tpl holds a double brace, which a Run Command document reads as a parameter."
    }
  }
}

# ---------------------------------------------------------------------------
# The box.
# ---------------------------------------------------------------------------

resource "aws_instance" "api" {
  ami                    = data.aws_ssm_parameter.ubuntu_arm64.value
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [var.security_group_id]
  iam_instance_profile   = aws_iam_instance_profile.api.name

  # IMDSv2 only. Hop limit 2 so containers on the Docker bridge can reach the
  # instance role, which is how the API gets its credentials (TD-19).
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    delete_on_termination = true
  }

  credit_specification {
    cpu_credits = var.cpu_credits
  }

  # The Dokploy installer is vendored (installer/) and embedded in user_data,
  # so what runs as root at first boot is exactly what was reviewed here.
  user_data = templatefile("${path.module}/templates/user_data.sh.tpl", {
    hostname        = local.name
    environment     = var.environment
    domain          = var.domain
    region          = local.region
    log_group       = local.log_group_name
    backup_bucket   = var.backup_bucket
    backup_prefix   = local.backup_prefix
    dokploy_version = var.dokploy_version
    # The reviewed installer travels inside user_data (about 6 KB compressed),
    # so a rebuild never depends on what dokploy.com serves that day; the
    # hash is checked after decoding as a self-test of the transport.
    dokploy_installer        = base64gzip(file("${path.module}/installer/dokploy-install.sh"))
    dokploy_installer_sha256 = filesha256("${path.module}/installer/dokploy-install.sh")
    # The same RDS bundle the API image carries (apps/api/certs); the box's own
    # psql (preview cleanup) verifies the database with it.
    rds_ca_sha256 = filesha256("${path.module}/../../../apps/api/certs/rds-eu-central-1-bundle.pem")
    headroom      = base64gzip(local.headroom)
  })

  # A newer AMI or an edited first-boot script must not replace the running
  # box: Dokploy's configuration is the one manual island (ADR-001). Rebuild on
  # purpose with `tofu apply -replace=module.compute.aws_instance.api`.
  lifecycle {
    ignore_changes = [ami, user_data]
  }

  tags = { Name = local.name }
}

resource "aws_eip" "api" {
  domain = "vpc"

  tags = { Name = local.name }
}

resource "aws_eip_association" "api" {
  instance_id   = aws_instance.api.id
  allocation_id = aws_eip.api.id
}
