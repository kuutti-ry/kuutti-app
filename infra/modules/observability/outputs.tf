output "alerts_topic_arn" {
  description = "Delivery test: aws sns publish --topic-arn <arn> --subject 'kuutti alert test' --message test"
  value       = aws_sns_topic.alerts.arn
}

output "alarm_names" {
  value = [
    aws_cloudwatch_metric_alarm.instance_status.alarm_name,
    aws_cloudwatch_metric_alarm.instance_credits.alarm_name,
    aws_cloudwatch_metric_alarm.memory_low.alarm_name,
    aws_cloudwatch_metric_alarm.db_storage.alarm_name,
    aws_cloudwatch_metric_alarm.db_credits.alarm_name,
    aws_cloudwatch_metric_alarm.five_xx.alarm_name,
    aws_cloudwatch_metric_alarm.photo_budget_refusals.alarm_name,
    aws_cloudwatch_metric_alarm.nightly_failures.alarm_name,
    aws_cloudwatch_metric_alarm.api_unreachable.alarm_name,
  ]
}
