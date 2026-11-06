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

variable "domain" {
  description = "The project domain; the certificate and the alias records live in its zone."
  type        = string
}

variable "zone_id" {
  description = "Hosted zone of the project domain (data.aws_route53_zone in the environment)."
  type        = string
}

variable "api_fqdn" {
  description = "The public name of the API, which becomes the distribution's alias: api.<env>.<domain>. Photos are served under /media/ on the same name."
  type        = string
}

variable "origin_fqdn" {
  description = "The name the distribution connects to the box by, pointing at the Elastic IP (origin.api.<env>.<domain>): Traefik must hold a certificate for it. Its port 80 takes Let's Encrypt's HTTP-01 challenge for every alias."
  type        = string
}

variable "origin_proof_store_arn" {
  description = "The environment's CloudFront key value store whose one key, origin-secret, the distribution sends to the box as x-kuutti-origin (ADR-066). The store is the environment's, so that it exists, and can be filled by hand, before the cutover; its value is never a resource (ADR-001)."
  type        = string
}

variable "extra_aliases" {
  description = "Names besides api_fqdn that the distribution serves for the box, each routed by Traefik on the forwarded Host: Dokploy's control plane and, on staging, the previews' wildcard (ADR-005 §7, #198). They are names on the certificate too; the environment's dns.tf points them at the distribution."
  type        = list(string)
  default     = []
}

variable "edge_requests_per_five_minutes" {
  description = "The edge's rate rule (#41, ADR-067): how many requests one viewer address may send in any five minutes, to every host and path of the distribution but a signed photo's and the two sign-in starts (edge.json), before AWS WAF answers it 429 until its rate falls back. Each environment sets its own; a change is a pull request and an apply, never a deploy."
  type        = number

  validation {
    condition     = var.edge_requests_per_five_minutes >= 10 && floor(var.edge_requests_per_five_minutes) == var.edge_requests_per_five_minutes
    error_message = "A WAF rate-based rule takes a whole number of requests, 10 at least."
  }
}

variable "instance_role_name" {
  description = "The API box's instance role (modules/compute output role_name); it gets the bucket policy attached."
  type        = string
}

variable "signing_public_key_pem" {
  description = "The public half of the current CloudFront signing key pair, PEM (infra/envs/<env>/cloudfront-signing-key.pub.pem). Its id is the API's CLOUDFRONT_KEY_PAIR_ID; the private half is /kuutti/<env>/cloudfront-signing-key in SSM and never in code (ADR-001, ADR-005). Checked by a precondition on the public key resource, so a dormant module (count = 0) with an empty value still validates."
  type        = string
}

variable "additional_signing_public_keys_pem" {
  description = "Public halves the key group trusts besides the current one, PEM: the next key during a rotation, the previous key for the twenty minutes its URLs may still be valid, a photo sent in a conversation's the longest (infra/envs/<env>/cloudfront-signing-key.*.pub.pem; ADR-031 §10)."
  type        = list(string)
  default     = []
}
