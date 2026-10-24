output "instance_id" {
  value = aws_instance.api.id
}

output "public_ip" {
  description = "The Elastic IP; DNS for api.<domain> points here."
  value       = aws_eip.api.public_ip
}

output "role_name" {
  value = aws_iam_role.api.name
}

output "role_arn" {
  value = aws_iam_role.api.arn
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.api.name
}

output "ssm_prefix" {
  value = local.ssm_prefix
}

output "backup_prefix" {
  value = "s3://${var.backup_bucket}/${local.backup_prefix}"
}

output "headroom_document" {
  description = "Name of the Run Command document that gives a running box its swap, Dokploy's memory limit and the free-memory metric (#77, ADR-046); infra/README.md, The box's headroom."
  value       = aws_ssm_document.headroom.name
}

output "preview_database_document" {
  description = "Name of the Run Command document preview-cleanup.yml sends to drop kuutti_pr_<n>; null where previews do not run."
  value       = var.preview_databases ? aws_ssm_document.preview_database[0].name : null
}
