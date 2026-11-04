variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "kuutti"
}

variable "environment" {
  description = "staging or prod. Names resources and the Environment tag."
  type        = string

  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "vpc_cidr" {
  description = "One /16 per environment; the three subnets are carved from it."
  type        = string
}

variable "ssh_cidrs" {
  description = "CIDRs allowed to reach port 22 on the API instance. Empty means no SSH rule at all; Session Manager is the intended path and this list exists only until it is proven (#7)."
  type        = list(string)
  default     = []
}

variable "cloudfront_only_ingress" {
  description = "When true, port 443 admits only CloudFront's origin-facing prefix list (ADR-005), so the box is reachable through the distribution alone. Off until Dokploy's control plane (deploy.yml) and the pull-request previews are served through the distribution too: today they reach the box on 443 directly. Port 80 stays open for the ACME challenge and the redirect either way."
  type        = bool
  default     = false
}
