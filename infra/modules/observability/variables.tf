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

variable "memory_available_mb" {
  description = "Available memory on the API box, in MiB, under which for five minutes the memory-low alarm mails (#77, ADR-046)."
  type        = number
  default     = 200
}
