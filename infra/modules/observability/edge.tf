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

  alarm_name          = "${local.name}-edge-rate-limited"
  alarm_description   = "The edge refused an address past its limit of requests within five minutes (#41, ADR-067). First steps: docs/runbooks/abuse.md."
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts_us_east_1.arn]
  ok_actions          = [aws_sns_topic.alerts_us_east_1.arn]

  # WAF publishes BlockedRequests only for a minute that has a refusal. On the
  # bare metric, CloudWatch kept judging the last refusal for as long as its
  # evaluation range still held it, ignoring treat_missing_data, so after the
  # burst test of 2026-11-06 the alarm stayed in ALARM long after the edge had
  # stopped refusing. FILL counts a five minutes with no refusal as 0, so the
  # OK comes with the first such five minutes, and says that it is over.
  metric_query {
    id          = "refused"
    expression  = "FILL(blocked, 0)"
    label       = "Requests the edge refused"
    return_data = true
  }

  metric_query {
    id = "blocked"

    metric {
      namespace   = "AWS/WAFV2"
      metric_name = "BlockedRequests"
      # Rule ALL is the whole web ACL; its one blocking rule is the rate rule.
      dimensions = { WebACL = var.edge_web_acl_metric_name, Rule = "ALL" }
      stat       = "Sum"
      period     = 300
    }
  }
}
