variable "project" {
  type    = string
  default = "kuutti"
}

variable "environment" {
  type = string

  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "instance_type" {
  description = "arm64 only: images are built for linux/arm64 (rules/infra.md)."
  type        = string
  default     = "t4g.small"
}

variable "subnet_id" {
  description = "The public subnet from modules/network."
  type        = string
}

variable "security_group_id" {
  description = "The api security group from modules/network."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Bootstrap output permissions_boundary_arn. The apply role refuses to create a role without it (ADR-001)."
  type        = string
}

variable "backup_bucket" {
  description = "Bucket that receives the nightly /etc/dokploy backup under dokploy-backup/<env>/ (#7: the state bucket)."
  type        = string
}

variable "dokploy_version" {
  description = "Git tag of the Dokploy release whose install script runs at first boot. Pinned so a rebuilt box gets the same version as the last one. A bump checks ADR-048's two points of Dokploy's code: no default router when dokploy.yml exists, and a router added when Dokploy's domain is assigned; and the Traefik tag that infra/scripts/dokploy-setup.sh pulls, which must be the new release's TRAEFIK_VERSION (ADR-053)."
  type        = string
}

variable "swap_mb" {
  description = "Size of the box's /swapfile in MiB, 0 for none (#77, ADR-046). Set by each environment: swap may page the API's memory, a hetu in flight during a callback included, to the root volume, which ADR-046 leaves to the maintainer for production (rule 1)."
  type        = number

  validation {
    condition     = var.swap_mb >= 0 && floor(var.swap_mb) == var.swap_mb
    error_message = "swap_mb is a whole number of MiB, 0 for no swap file."
  }
}

variable "root_volume_gb" {
  type    = number
  default = 30
}

variable "manage_session_preferences" {
  description = "Session Manager preferences (the SSM-SessionManagerRunShell document and the shared session log group) are account-wide, so exactly one environment declares them: staging, which always exists."
  type        = bool
  default     = false
}

variable "preview_databases" {
  description = "Staging only (#9): declares the Run Command document that drops a pull request's kuutti_pr_<n>, which preview-cleanup.yml sends through the plan role as the kuutti_preview role that infra/scripts/db-app-role.sh creates on staging."
  type        = bool
  default     = false
}

variable "cpu_credits" {
  description = "t4g burst mode: standard caps the bill at baseline performance, unlimited keeps performance and bills surplus credits (TD-19). Staging standard, prod unlimited with its credit alarms."
  type        = string
  default     = "unlimited"

  validation {
    condition     = contains(["standard", "unlimited"], var.cpu_credits)
    error_message = "cpu_credits must be standard or unlimited."
  }
}

variable "domain" {
  description = "The project domain; the instance role sends mail as noreply@<domain> through its SES identity (#385, ADR-043 §5)."
  type        = string
  default     = "kuutti.app"
}

variable "mail_recipients" {
  description = "The addresses the instance role may mail, patterns such as *@example.fi allowed (#385, ADR-043 §6): staging lists its testers, since anyone can sign in there as one of Telia's test persons, whose credentials are published. Null, production's, limits nothing."
  type        = list(string)
  default     = null

  validation {
    condition     = var.mail_recipients == null ? true : length(var.mail_recipients) > 0
    error_message = "mail_recipients is null (no limit) or names at least one address."
  }
}
