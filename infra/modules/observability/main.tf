# ---------------------------------------------------------------------------
# Alarms and log queries for one environment (#11, TD-19). The box is a single
# point of failure that degrades rather than fails when its CPU credits run
# out, and RDS does the same with storage and credits; an alarm is the only way
# to know. Everything notifies one SNS topic in this region (a CloudWatch alarm
# can only publish to a topic in its own region; the billing topic sits in
# us-east-1 for the same reason and is not reused). The email subscription is
# confirmed by hand from the mailbox, like the billing one.
#
# Cost: standard alarms at 0.10 USD and custom metrics at 0.30 USD each (the
# 5xx and Rekognition metrics, and the exposure-budget one of #52), so about
# 1.60 USD a month per environment; query definitions and the topic are free. The probe from outside the box, which is what catches a stopped
# container, is probe.tf (#29): a Route 53 health check with its alarm and
# topic in us-east-1.
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

locals {
  name      = "${var.project}-${var.environment}"
  namespace = "Kuutti/${var.environment}"
}

resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

# CloudWatch may publish, this account's alarms only.
data "aws_iam_policy_document" "alerts" {
  statement {
    sid       = "AllowCloudWatchAlarms"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts.json
}

# CI hands the address in as TF_VAR_alert_email from a repository variable; an
# unset variable arrives as "", which must mean "no subscriber", not a
# subscription with an empty endpoint (SNS refuses it and fails the apply).
resource "aws_sns_topic_subscription" "email" {
  count = var.alert_email == null || trimspace(var.alert_email) == "" ? 0 : 1

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# --- The box --------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "instance_status" {
  alarm_name          = "${local.name}-instance-status-check-failed"
  alarm_description   = "The API instance fails its EC2 status checks (hardware or OS). First steps: docs/runbooks/alerts.md."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  dimensions          = { InstanceId = var.instance_id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching" # a stopped or terminated instance reports nothing
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# t4g burst credits: the box slows to baseline when they are gone (TD-19), and
# in unlimited mode starts costing money instead.
resource "aws_cloudwatch_metric_alarm" "instance_credits" {
  alarm_name          = "${local.name}-instance-cpu-credits-low"
  alarm_description   = "The API instance's CPU credit balance is nearly spent; it is about to slow down or, in unlimited mode, cost extra."
  namespace           = "AWS/EC2"
  metric_name         = "CPUCreditBalance"
  dimensions          = { InstanceId = var.instance_id }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 20
  comparison_operator = "LessThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# --- The database ---------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "db_storage" {
  alarm_name          = "${local.name}-db-free-storage-low"
  alarm_description   = "RDS free storage is under 2 GB; autoscaling stops at max_allocated_storage and a full disk stops writes."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = var.db_identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 2147483648 # 2 GiB in bytes
  comparison_operator = "LessThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "db_credits" {
  alarm_name          = "${local.name}-db-cpu-credits-low"
  alarm_description   = "The RDS instance's CPU credit balance is nearly spent; queries are about to slow down."
  namespace           = "AWS/RDS"
  metric_name         = "CPUCreditBalance"
  dimensions          = { DBInstanceIdentifier = var.db_identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 20
  comparison_operator = "LessThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# --- The API's own log lines ---------------------------------------------

# Every request is one JSON line from the request logger (apps/api/src/lib/
# logger.ts): {"msg":"request","status":503,...}. Server errors become a metric.
resource "aws_cloudwatch_log_metric_filter" "five_xx" {
  name           = "${local.name}-api-5xx"
  log_group_name = var.log_group_name
  pattern        = "{ $.msg = \"request\" && $.status >= 500 }"

  metric_transformation {
    name          = "Api5xx"
    namespace     = local.namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "five_xx" {
  alarm_name          = "${local.name}-api-5xx"
  alarm_description   = "The API answered ${var.five_xx_per_five_minutes} or more requests with a 5xx within five minutes."
  namespace           = local.namespace
  metric_name         = "Api5xx"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.five_xx_per_five_minutes
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching" # no requests is not an outage
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Every moderated photo is one log line with the number of Rekognition calls it
# cost ({"msg":"photo moderated","rekognitionCalls":3,...}, #49). Summed, that
# is the bill's driver besides the box; the billing alarm covers the rest.
resource "aws_cloudwatch_log_metric_filter" "rekognition_calls" {
  name           = "${local.name}-rekognition-calls"
  log_group_name = var.log_group_name
  pattern        = "{ $.msg = \"photo moderated\" && $.rekognitionCalls > 0 }"

  metric_transformation {
    name          = "RekognitionCalls"
    namespace     = local.namespace
    value         = "$.rekognitionCalls"
    default_value = "0"
  }
}

# Saved Logs Insights queries: the first three things to run when an alarm
# fires. pino levels: 50 error, 60 fatal.
resource "aws_cloudwatch_query_definition" "errors_by_route" {
  name            = "${local.name}/errors-by-route"
  log_group_names = [var.log_group_name]
  query_string    = <<-EOT
    fields @timestamp, requestId, route, status, msg
    | filter status >= 500 or level >= 50
    | stats count() as errors by route, status, msg
    | sort errors desc
  EOT
}

resource "aws_cloudwatch_query_definition" "latency_by_route" {
  name            = "${local.name}/p95-duration-by-route"
  log_group_names = [var.log_group_name]
  query_string    = <<-EOT
    filter msg = "request"
    | stats pct(durationMs, 95) as p95ms, pct(durationMs, 50) as p50ms, count() as requests by route
    | sort p95ms desc
  EOT
}

resource "aws_cloudwatch_query_definition" "boot" {
  name            = "${local.name}/boot-and-fatal"
  log_group_names = [var.log_group_name]
  query_string    = <<-EOT
    filter level >= 60 or msg in ["API listening", "migrations", "shutting down", "server error"]
    | fields @timestamp, level, msg, port, commit, version, applied, state
    | sort @timestamp desc
    | limit 50
  EOT
}

# A photo URL the API refused for the day's exposure budget is one warn line
# ({"msg":"photo refused","reason":"budget",...}, #52, TD-6, ADR-008). A few a
# day are people who scrolled a lot; a hundred is somebody's script, or a
# budget set too low, and either is worth a mail.
resource "aws_cloudwatch_log_metric_filter" "photo_budget_refusals" {
  name           = "${local.name}-photo-budget-refusals"
  log_group_name = var.log_group_name
  pattern        = "{ $.msg = \"photo refused\" && $.reason = \"budget\" }"

  metric_transformation {
    name          = "PhotoBudgetRefusals"
    namespace     = local.namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "photo_budget_refusals" {
  alarm_name          = "${local.name}-photo-budget-refusals"
  alarm_description   = "The API refused ${var.budget_refusals_per_day} or more photo fetches for the exposure budget within a day (#52): a scraper, or a budget set too low."
  namespace           = local.namespace
  metric_name         = "PhotoBudgetRefusals"
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = var.budget_refusals_per_day
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching" # no refusals is the normal day
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
