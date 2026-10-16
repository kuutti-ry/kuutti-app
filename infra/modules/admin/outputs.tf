output "bucket" {
  description = "GitHub environment variable ADMIN_BUCKET: CI syncs main's build to its root and a pull request's preview to pr-<n>/ (ADR-025 §5, §6)."
  value       = aws_s3_bucket.admin.bucket
}

output "distribution_id" {
  description = "GitHub environment variable ADMIN_DISTRIBUTION_ID: main's deploy invalidates /* on it after the sync (ADR-025 §4)."
  value       = aws_cloudfront_distribution.this.id
}

output "url" {
  description = "The panel's address, GitHub environment variable ADMIN_URL; the API's admin-app-url and CORS origin name the same host (ADR-025 §10)."
  value       = "https://${var.admin_fqdn}"
}
