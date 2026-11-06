# ---------------------------------------------------------------------------
# The outside probe (#29). The alarms in main.tf watch the box and the
# database; none of them sees a stopped API container, because the 5xx metric
# is the API's own log and a dead container logs nothing (proven on
# 2026-09-20: stopping the container fired nothing, stopping the instance
# fired StatusCheckFailed after 9 min 31 s). Route 53 health checkers call
# /health from several regions every 30 s and want the body to say the API is
# up, not only that something answers on 443; three failures in a row, about
# 90 s, is the alarm. Where the API trusts CloudFront's viewer address, the
# environment has the probe ask for a valid proof of Kuutti's distribution
# instead (ADR-066): a store and a parameter that disagree put everybody in
# one bucket, and that pages too. Route 53 counts only a 2xx or 3xx answer,
# and /health is 503 unless its status is ok, so the status is still asked.
#
# Health-check metrics are published in us-east-1 only, and a CloudWatch alarm
# can publish only to a topic in its own region, so the alarm and its topic
# live there, with the same subscriber as the regional topic (confirmed by hand
# from the mailbox, like the others). Cost: 0.50 USD a month for an HTTPS check
# with string matching, 0.10 for the alarm.
# ---------------------------------------------------------------------------

resource "aws_route53_health_check" "api" {
  fqdn              = var.api_fqdn
  port              = 443
  type              = "HTTPS_STR_MATCH"
  resource_path     = "/health"
  search_string     = var.health_search_string
  request_interval  = 30
  failure_threshold = 3
  measure_latency   = false
  # The API answers in eu-central-1; checkers nearer than the default set
  # keep the verdict about the API, not about the Atlantic.
  regions = ["eu-west-1", "us-east-1", "ap-southeast-1"]

  tags = { Name = "${local.name}-api-health" }
}

resource "aws_sns_topic" "alerts_us_east_1" {
  provider = aws.us_east_1
  name     = "${local.name}-alerts-us-east-1"
}

data "aws_iam_policy_document" "alerts_us_east_1" {
  statement {
    sid       = "AllowCloudWatchAlarms"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts_us_east_1.arn]

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

resource "aws_sns_topic_policy" "alerts_us_east_1" {
  provider = aws.us_east_1
  arn      = aws_sns_topic.alerts_us_east_1.arn
  policy   = data.aws_iam_policy_document.alerts_us_east_1.json
}

resource "aws_sns_topic_subscription" "email_us_east_1" {
  count    = var.alert_email == null || trimspace(var.alert_email) == "" ? 0 : 1
  provider = aws.us_east_1

  topic_arn = aws_sns_topic.alerts_us_east_1.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "api_unreachable" {
  provider            = aws.us_east_1
  alarm_name          = "${local.name}-api-unreachable"
  alarm_description   = "Route 53 health checkers cannot get a healthy /health from the API: the container, Traefik or the box is down, or, where the probe asks for it, the proof of Kuutti's distribution is not valid. First steps: docs/runbooks/alerts.md."
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  dimensions          = { HealthCheckId = aws_route53_health_check.api.id }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching" # a deleted or paused check reports nothing
  alarm_actions       = [aws_sns_topic.alerts_us_east_1.arn]
  ok_actions          = [aws_sns_topic.alerts_us_east_1.arn]
}
