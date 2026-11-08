output "instance_id" {
  value = module.compute.instance_id
}

output "headroom_document" {
  description = "Run Command document that gives the running box its swap and the free-memory metric (#77, ADR-046); infra/README.md, The box's headroom."
  value       = module.compute.headroom_document
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

output "api_url" {
  description = "GitHub environment variable API_URL."
  value       = "https://api.${var.domain}"
}

output "dokploy_url" {
  description = "GitHub environment variable DOKPLOY_URL."
  value       = "https://dokploy.${var.domain}"
}

output "admin_url" {
  description = "GitHub environment variable ADMIN_URL, in the environment prod: the moderation panel's host (#313, ADR-025)."
  value       = module.admin.url
}

output "admin_bucket" {
  description = "GitHub environment variable ADMIN_BUCKET, in the environment prod (ADR-025 §5)."
  value       = module.admin.bucket
}

output "admin_distribution_id" {
  description = "GitHub environment variable ADMIN_DISTRIBUTION_ID, in the environment prod: the panel's deploy invalidates it (ADR-025 §4)."
  value       = module.admin.distribution_id
}

output "alerts_topic_arn" {
  description = "Alarm notifications (#11); the email subscription is confirmed from the mailbox."
  value       = module.observability.alerts_topic_arn
}
