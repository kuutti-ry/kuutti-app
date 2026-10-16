output "instance_id" {
  value = module.compute.instance_id
}

output "public_ip" {
  description = "Point api.<domain> here."
  value       = module.compute.public_ip
}

output "db_identifier" {
  value = module.data.identifier
}

output "db_host" {
  value = module.data.address
}

output "db_master_secret_arn" {
  description = "Read once by the maintainer to create the application role (infra/scripts/db-app-role.sh)."
  value       = module.data.master_user_secret_arn
}

output "log_group_name" {
  value = module.compute.log_group_name
}

output "backup_prefix" {
  value = module.compute.backup_prefix
}

output "preview_database_document" {
  description = "Run Command document preview-cleanup.yml sends to drop a pull request's database (#9)."
  value       = module.compute.preview_database_document
}

output "api_url" {
  description = "GitHub environment variable API_URL; ADMIN_API_URL in the environment preview, since the panel's previews call this API (ADR-025 §6)."
  value       = "https://api.staging.${var.domain}"
}

output "dokploy_url" {
  description = "GitHub environment variable DOKPLOY_URL."
  value       = "https://dokploy.staging.${var.domain}"
}

output "preview_api_domain" {
  description = "GitHub environment variable PREVIEW_API_DOMAIN (#9): previews answer on pr-<n>.<this>."
  value       = "preview.api.staging.${var.domain}"
}

output "admin_url" {
  description = "GitHub environment variable ADMIN_URL, in the environments staging and preview: the moderation panel's host (#313, ADR-025)."
  value       = module.admin.url
}

output "admin_bucket" {
  description = "GitHub environment variable ADMIN_BUCKET, in the environments staging, preview and preview-cleanup (ADR-025 §5-§8)."
  value       = module.admin.bucket
}

output "admin_distribution_id" {
  description = "GitHub environment variable ADMIN_DISTRIBUTION_ID, in the environment staging: main's panel deploy invalidates it (ADR-025 §4)."
  value       = module.admin.distribution_id
}

output "alerts_topic_arn" {
  description = "Alarm notifications (#11); the email subscription is confirmed from the mailbox."
  value       = module.observability.alerts_topic_arn
}
