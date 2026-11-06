# The edge's rate rule (#41, ADR-067): the web ACL on the API's distribution
# (modules/media) refuses an address past its limit at CloudFront, so the box
# never sees those requests and the API's refusals alarm cannot count them.
# AWS WAF publishes a CloudFront web ACL's metrics in us-east-1, with no Region
# dimension, and an alarm publishes only to a topic of its own region, so this
# one mails through the probe's topic (probe.tf). Any refusal is a mail: no
# person browsing reaches the limit, so a block is a flood or a script, and
# the OK that follows says it is over. Cost: 0.10 USD a month.

resource "aws_cloudwatch_metric_alarm" "edge_rate_limited" {
  count    = var.edge_web_acl_metric_name == null ? 0 : 1
  provider = aws.us_east_1

  alarm_name        = "${local.name}-edge-rate-limited"
  alarm_description = "The edge refused an address past its limit of requests within five minutes (#41, ADR-067). First steps: docs/runbooks/abuse.md."
  namespace         = "AWS/WAFV2"
  metric_name       = "BlockedRequests"
  # Rule ALL is the whole web ACL; its one blocking rule is the rate rule.
  dimensions          = { WebACL = var.edge_web_acl_metric_name, Rule = "ALL" }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching" # WAF reports no blocks when there are none
  alarm_actions       = [aws_sns_topic.alerts_us_east_1.arn]
  ok_actions          = [aws_sns_topic.alerts_us_east_1.arn]
}
