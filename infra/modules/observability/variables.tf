variable "project" {
  type    = string
  default = "kuutti"
}

variable "environment" {
  description = "staging or prod; names every resource and the metric namespace."
  type        = string
}

variable "instance_id" {
  description = "The API box (modules/compute)."
  type        = string
}

variable "db_identifier" {
  description = "The RDS instance (modules/data)."
  type        = string
}

variable "log_group_name" {
  description = "The API container's log group (modules/compute); the 5xx metric filter reads it."
  type        = string
}

variable "alert_email" {
  description = "Mailbox subscribed to the alert topic. Null or empty creates the topic without a subscriber; the address is a project alias, never a personal one (TD-4)."
  type        = string
  default     = null
}

variable "five_xx_per_five_minutes" {
  description = "Server errors within five minutes that raise the 5xx alarm."
  type        = number
  default     = 5
}

variable "api_fqdn" {
  description = "The API's public host name (api.staging.<domain> or api.<domain>): what the outside probe calls."
  type        = string
}

variable "budget_refusals_per_day" {
  description = "Photo fetches refused for the exposure budget within one day that raise the alarm (#52): absurd for 5,000 people, ordinary for one script."
  type        = number
  default     = 100
}

variable "bank_identifications_per_day" {
  description = "Identifications the bank passes on within one day that raise the alarm (#471). Each environment sets its own: production's are billed by Telia, staging's test bed is free."
  type        = number
}

variable "memory_available_mb" {
  description = "Available memory on the API box, in MiB, under which for five minutes the memory-low alarm mails (#77, ADR-046)."
  type        = number
  default     = 200
}

variable "refusals_per_five_minutes" {
  description = "The API's refusals within five minutes that raise its refusals alarm (#41, ADR-026 §7): 429s on the request line, the limits' and the day's budgets', and sign-in starts refused or evicted."
  type        = number
  default     = 100
}

variable "edge_web_acl_metric_name" {
  description = "The metric name of the API distribution's web ACL (modules/media output edge_web_acl_metric_name, ADR-067), whose refusals the edge alarm counts; null where the environment has no distribution yet, as production before its cutover."
  type        = string
  default     = null
}

variable "health_search_string" {
  description = "What the Route 53 probe wants in /health's body. \"status\":\"ok\" by default; \"originProof\":\"valid\" where the API trusts CloudFront's viewer address (ADR-066): /health is 503 unless its status is ok, and Route 53 counts a 5xx as a failure, so the status is still asked."
  type        = string
  default     = "\"status\":\"ok\""
}
