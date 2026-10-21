output "state_bucket" {
  description = "Backend bucket. Put this in the backend block of every environment."
  value       = aws_s3_bucket.state.id
}

output "backend_config" {
  description = "Paste into versions.tf of each environment, changing the key."
  value       = <<-EOT
    backend "s3" {
      bucket       = "${aws_s3_bucket.state.id}"
      key          = "<env>/terraform.tfstate"
      region       = "${var.region}"
      encrypt      = true
      use_lockfile = true
    }
  EOT
}

output "ci_plan_role_arn" {
  description = "Assumed by the plan job on pull requests and on main."
  value       = aws_iam_role.ci_plan.arn
}

output "ci_export_role_arn" {
  description = "Assumed by export.yml, from the main branch only; may put objects under github-export/ in the state bucket."
  value       = aws_iam_role.ci_export.arn
}

output "ci_apply_role_arn" {
  description = "Assumed by the apply job, only from a GitHub environment."
  value       = aws_iam_role.ci_apply.arn
}

output "oidc_provider_arn" {
  value = aws_iam_openid_connect_provider.github.arn
}

output "permissions_boundary_arn" {
  description = "Every role created by the apply role must set permissions_boundary to this ARN, or the create call is refused."
  value       = aws_iam_policy.boundary.arn
}

output "billing_topic_arn" {
  description = "Budget and billing-alarm notifications go here. Test delivery: aws sns publish --region us-east-1 --topic-arn <arn> --subject 'kuutti billing test' --message test"
  value       = aws_sns_topic.billing.arn
}

output "dns_zone_id" {
  description = "Hosted zone of the project domain; environments look it up by name."
  value       = aws_route53_zone.main.zone_id
}

output "dns_name_servers" {
  description = "Must equal the name servers on the domain registration (Route 53, Registered domains)."
  value       = aws_route53_zone.main.name_servers
}

output "ses_identity_arn" {
  description = "The SES identity of the project domain (#385, ADR-043 §5). Each environment's instance role may send through it from noreply@ alone (modules/compute, SesSendAsNoreply)."
  value       = aws_sesv2_email_identity.main.arn
}
