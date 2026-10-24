variable "project" {
  description = "Name prefix for all resources."
  type        = string
  default     = "kuutti"
}

variable "domain" {
  description = "The project domain, registered through Route 53 in this account (README, Domain). One variable here and in each environment, so a later change of domain is one line per root."
  type        = string
  default     = "kuutti.app"
}

variable "region" {
  description = "AWS region. Everything lives in one region (TD-4)."
  type        = string
  default     = "eu-central-1"
}

# kuutti-app was created after 15 July 2026, so GitHub issues immutable subject
# claims: the sub is repo:kuutti-ry@<owner_id>/kuutti-app@<repo_id>:... rather
# than the name-based form. Trust policies below key on these numeric IDs, which
# are stable across renames. Get them with:
#   gh api repos/kuutti-ry/kuutti-app --jq '{repo_id: .id, owner_id: .owner.id}'

variable "github_owner_id" {
  description = "Numeric ID of the kuutti-ry organisation."
  type        = string
}

variable "github_repository_id" {
  description = "Numeric ID of the kuutti-app repository."
  type        = string
}

variable "deploy_environments" {
  description = "GitHub environments allowed to assume the apply role."
  type        = list(string)
  default     = ["staging", "prod"]
}

variable "billing_alert_email" {
  description = "Mailbox for budget and billing-alarm notifications: an alias on the project domain, never a personal address (TD-4). The SNS subscription is confirmed from that mailbox."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.billing_alert_email))
    error_message = "billing_alert_email must be an email address; set it in terraform.tfvars."
  }
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget in USD, since the AWS/Billing metric behind the alarm is USD-only; the budget uses the same number. TD-4 set 50 EUR (55) for staging alone; 110 while production runs beside it (ADR-049), counted before credits."
  type        = number
  default     = 110
}

variable "github_domain_verification" {
  description = "GitHub organisation domain verification (#16 B.1): the record name GitHub shows, without the domain (for example _gh-kuutti-ry-o), and its code. Null until an owner has started the verification."
  type = object({
    name = string
    code = string
  })
  default = null

  validation {
    condition     = var.github_domain_verification == null || !strcontains(var.github_domain_verification.name, ".")
    error_message = "name is the record's first label only (for example _gh-kuutti-ry-o): the domain is appended here."
  }
}
