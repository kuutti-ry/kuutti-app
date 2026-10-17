output "read_role_arn" {
  description = "The researcher's read-only role: the role_arn of the profile handed over, and the one resource of the permission set's inline policy (infra/README.md, Research copy)."
  value       = aws_iam_role.reader.arn
}

output "permission_set" {
  description = "The Identity Center permission set whose role the trust admits; created and assigned by the maintainer, never by this code."
  value       = local.permission_set
}

output "uri" {
  description = "Where the copy is read from: s3://<bucket>/research/."
  value       = "s3://${var.bucket}/${var.prefix}"
}

output "access_log_bucket" {
  description = "The trail's bucket: AWSLogs/<account>/CloudTrail/<region>/YYYY/MM/DD/ holds every object call under the prefix."
  value       = aws_s3_bucket.access_log.bucket
}

output "trail_name" {
  value = aws_cloudtrail.research.name
}
