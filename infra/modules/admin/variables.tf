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

variable "zone_id" {
  description = "Hosted zone of the project domain (data.aws_route53_zone in the environment)."
  type        = string
}

variable "admin_fqdn" {
  description = "The panel's public name, which becomes the distribution's alias: admin.<env>.<domain> (admin.<domain> in production, #25). The API's admin-app-url names the same host (ADR-025 §10)."
  type        = string
}

variable "api_origin" {
  description = "The API's origin, https://api.<env>.<domain>: the only connect-src of the panel's CSP, and with 'self' its img-src, since the photos are URLs signed on the API's name (ADR-005, ADR-025 §3)."
  type        = string
}
