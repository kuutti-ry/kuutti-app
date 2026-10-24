# ---------------------------------------------------------------------------
# Billing guard rails (TD-4). Account-level, so they belong to the bootstrap
# rather than to an environment: a monthly budget alerting at 80 % and 100 %,
# and the CloudWatch billing alarm as a second, faster signal (the budget
# evaluates daily; the billing metric updates several times a day). Both notify
# one SNS topic whose only subscriber is the billing alias, so
# `aws sns publish` to the topic is the delivery test.
#
# The AWS/Billing metric is published only after "Receive CloudWatch billing
# alerts" is enabled once in Billing preferences (README). Until then the alarm
# sits in INSUFFICIENT_DATA, which is why missing data is treated as fine.
# ---------------------------------------------------------------------------

# An alarm's SNS action must be in the alarm's region, and billing alarms exist
# only in us-east-1, so the topic lives there as well.
resource "aws_sns_topic" "billing" {
  provider = aws.us_east_1
  name     = "${var.project}-billing-alerts"
}

# Budgets deliver to SNS only if the topic policy names the service; CloudWatch
# is listed for the same reason once the default policy is replaced. Both are
# pinned to this account so no other account's budget can publish here.
data "aws_iam_policy_document" "billing_topic" {
  statement {
    sid       = "AllowBudgetsAndCloudWatch"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.billing.arn]

    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com", "cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "billing" {
  provider = aws.us_east_1
  arn      = aws_sns_topic.billing.arn
  policy   = data.aws_iam_policy_document.billing_topic.json
}

# Email subscriptions start as "pending confirmation" and become active when the
# link in AWS's confirmation mail is followed from the billing mailbox.
resource "aws_sns_topic_subscription" "billing_email" {
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.billing.arn
  protocol  = "email"
  endpoint  = var.billing_alert_email
}

resource "aws_budgets_budget" "monthly" {
  # Budgets checks at creation that it may publish to each subscriber topic, so
  # the topic policy has to exist first; the ARN alone does not order it.
  depends_on = [aws_sns_topic_policy.billing]

  name         = "${var.project}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Usage before credits (ADR-049): netted, as Budgets does by default, the
  # association's credit would keep the budget near zero while it lasts and
  # hide a cost that runs away.
  cost_types {
    include_credit = false
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.billing.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.billing.arn]
  }
}

resource "aws_cloudwatch_metric_alarm" "estimated_charges" {
  provider            = aws.us_east_1
  alarm_name          = "${var.project}-estimated-charges"
  alarm_description   = "Month-to-date estimated charges exceed the monthly budget (TD-4)."
  namespace           = "AWS/Billing"
  metric_name         = "EstimatedCharges"
  dimensions          = { Currency = "USD" }
  statistic           = "Maximum"
  period              = 21600 # the metric updates a few times a day; six hours avoids gaps
  evaluation_periods  = 1
  threshold           = var.monthly_budget_usd
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.billing.arn]
  ok_actions          = [aws_sns_topic.billing.arn]
}
