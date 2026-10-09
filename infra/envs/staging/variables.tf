variable "vpc_cidr" {
  type    = string
  default = "10.10.0.0/16"
}

variable "instance_type" {
  type    = string
  default = "t4g.small"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_deletion_protection" {
  type    = bool
  default = false
}

variable "ssh_cidrs" {
  description = "Maintainer CIDRs for port 22, empty by default; Session Manager is the intended path."
  type        = list(string)
  default     = []
}

variable "dokploy_version" {
  description = "Dokploy release tag installed at first boot (the dokploy/dokploy image tag). Bumped deliberately; a running box is updated with the installer's update command, not by apply."
  type        = string
  default     = "v0.30.6"
}

variable "domain" {
  description = "The project domain; its hosted zone is declared in infra/bootstrap."
  type        = string
  default     = "kuutti.app"
}

variable "alert_email" {
  description = "Subscriber of the alert topic (#11): CI passes the repository variable ALERT_EMAIL as TF_VAR_alert_email. Null leaves the topic without a subscriber."
  type        = string
  default     = null
}

variable "admin_app_url" {
  description = "Where the staff login returns to and the moderation panel lives (#49, ADR-006): /kuutti/staging/admin-app-url. A developer's panel (Vite) against staging until the panel has a host (ADR-006 §7)."
  type        = string
  default     = "http://localhost:5173"
}

variable "cors_allowed_origins" {
  description = "Browser origins the API answers (rule 8: the admin panel and the waitlist site only), comma separated: /kuutti/staging/cors-allowed-origins. The panel's origin must be here or its preflight fails."
  type        = string
  default     = "http://localhost:5173"
}

variable "telia_client_id" {
  description = "The client_id Telia Tunnistus assigned to Kuutti on its pre-production bed (#32, docs/vendors/telia.md): /kuutti/staging/oidc-client-id. Public by OIDC design (it travels in every authorization URL), so it is a default here; Telia's provisioning mail of 2026-10-08 (ticket 01121315) carries it. Null keeps bank identification off: the issuer, the registered redirect URI and the acr value are written only together with it, because the API refuses half a configuration at boot. The two private keys are /kuutti/staging/telia-signing-key and -encryption-key, never resources (infra/README.md, Secrets)."
  type        = string
  default     = "b9b08a7a-ebb4-4a8c-a3e7-52824d3231e5"
}

variable "media_enabled" {
  description = "Photos (#48, ADR-005): the media bucket, the CloudFront distribution in front of the API and the bucket, and the signed-URL key group. Flipped to true in the cutover commit, after the maintainer has created /kuutti/<env>/cloudfront-signing-key in SSM, committed its public half as cloudfront-signing-key.pub.pem next to this file, and given the api application the origin.api.<env> domain in Dokploy (infra/README.md, Media)."
  type        = bool
  default     = true
}

variable "cloudfront_only_ingress" {
  description = "Passed to the network module: HTTPS from CloudFront's prefix list only. Off until Dokploy and the previews are behind the distribution too (ADR-005)."
  type        = bool
  default     = false
}

variable "trusted_proxy" {
  description = "Whose word the API takes for the client address behind its rate limiter (#52, audit F19, ADR-008): /kuutti/staging/trusted-proxy. traefik while the box answers 443 directly (the last X-Forwarded-For hop, the one Traefik appends); cloudfront once cloudfront_only_ingress is on (CloudFront's viewer address), and never before, since until then anyone reaching the origin could send that header."
  type        = string
  default     = "traefik"

  validation {
    condition     = contains(["traefik", "cloudfront"], var.trusted_proxy)
    error_message = "trusted_proxy is traefik or cloudfront."
  }
}
