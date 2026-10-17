variable "project" {
  type    = string
  default = "kuutti"
}

variable "environment" {
  description = "staging or prod; names the role, the trail, the log bucket and the Identity Center permission set the trust admits (KuuttiResearchStaging, KuuttiResearchProd)."
  type        = string

  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "bucket" {
  description = "The media bucket the research copy lives in (modules/media output bucket)."
  type        = string
}

variable "bucket_arn" {
  description = "Its ARN (modules/media output bucket_arn)."
  type        = string
}

variable "prefix" {
  description = "Where in the bucket the copy lives (modules/media output research_prefix): every right and the trail's selector stop at it."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+/$", var.prefix))
    error_message = "prefix is one folder ending in a slash, such as research/: a policy on an empty or wildcard prefix would open the whole bucket."
  }
}

variable "instance_role_name" {
  description = "The API box's instance role (modules/compute output role_name); it gets the write-once policy on the prefix."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Bootstrap output permissions_boundary_arn. The apply role refuses to create a role without it (ADR-001)."
  type        = string
}
