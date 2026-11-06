# The edge's rate rule (#41, ADR-067): one AWS WAF web ACL on the
# distribution, with one rate-based rule, so that a flood from one address
# through it is refused at CloudFront, before the box. The two sign-in starts
# stay the API's, whose refusal is a redirect (edge.json). The API's own
# windows come after it and stay what they are (ADR-026): this rule is for
# volume, not for who is asking, which only the API can tell.
#
# A CloudFront web ACL lives in us-east-1 and AWS publishes its metrics there,
# so its alarm is observability's, beside the probe's (ADR-067 §6). No WAF
# logs and no sampled requests: both would keep each viewer's address, and the
# samples every header, the session's bearer token among them (ADR-067 §4).
#
# Cost: 5 USD a month for the web ACL, 1 USD for the rule and 0.60 USD per
# million requests it inspects, so about 6 USD a month per environment at
# Kuutti's size; the IP set and the custom answer are free.

locals {
  edge_metric_name = "${local.name}-edge"
  # The refusal's body and the paths the rule leaves to the API, in one file
  # that the API's tests hold to the limiter's own 429 (lib/rate-limit.test.ts)
  # and to the sign-in starts (identity/edge.test.ts).
  edge = jsondecode(file("${path.module}/edge.json"))
}

# Addresses the rule does not count: the load smoke's runner, for the hour of
# a run (docs/runbooks/capacity.md). Written and emptied by hand with the CLI,
# never here, so no address enters the repository; OpenTofu declares the set
# empty and leaves what is in it alone. An IP set holds one family: the run
# goes over IPv4 (the runbook's --dns-result-order=ipv4first), and a runner
# with IPv6 alone would need a set of its own.
resource "aws_wafv2_ip_set" "unlimited" {
  provider = aws.us_east_1

  # A WAF description takes no apostrophe and no parenthesis.
  name               = "${local.name}-edge-unlimited"
  description        = "Not counted by the edge rate rule: the load smoke runner for its hour, written by hand, ADR-067"
  scope              = "CLOUDFRONT"
  ip_address_version = "IPV4"
  addresses          = []

  lifecycle {
    ignore_changes = [addresses]
  }
}

resource "aws_wafv2_web_acl" "edge" {
  provider = aws.us_east_1

  name        = local.edge_metric_name
  description = "The edge rate rule in front of the box, #41, ADR-067"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # The refusal in the API's own envelope (packages/schema, ErrorResponse), so
  # that the app and the load smoke read it as the API's rate_limited. Clients
  # give the code their own text and never show this message. The request id
  # names the edge: no request reached the box.
  custom_response_body {
    key          = "rate_limited"
    content_type = "APPLICATION_JSON"
    content      = jsonencode(local.edge.refusal)
  }

  rule {
    name     = "requests-per-address"
    priority = 0

    action {
      block {
        custom_response {
          response_code            = 429
          custom_response_body_key = "rate_limited"

          # The window: an address that stops is let through again once its
          # count over the last five minutes is under the limit.
          response_header {
            name  = "Retry-After"
            value = "300"
          }
        }
      }
    }

    statement {
      rate_based_statement {
        # Requests from one address in any five minutes: the address CloudFront
        # took the connection from, never a header a client wrote. An IPv6
        # address counts on its own, not by its /64 as the API counts it.
        limit                 = var.edge_requests_per_five_minutes
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        # Counted, and refused, is everything the distribution sends to the
        # box: the API, Dokploy, the previews and the ACME path. Not counted:
        scope_down_statement {
          and_statement {
            # A signed photo, in the one shape the API signs
            # (media/<sha256>/<variant>.webp, apps/api/src/media/store.ts):
            # CloudFront serves it from its cache or the bucket, never from the
            # box, and photos are the most a person browsing asks for. Only
            # that shape: CloudFront picks a behaviour on the path it has
            # normalised and sends the raw one on, and the box resolves it too,
            # so a prefix would let /media/../health reach the box uncounted.
            # This shape has nothing in it to normalise.
            statement {
              not_statement {
                statement {
                  regex_match_statement {
                    regex_string = "^/${local.media_prefix}[0-9a-f]{64}/[a-z]+\\.webp$"

                    field_to_match {
                      uri_path {}
                    }

                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }
              }
            }

            # The two sign-in starts, by their exact raw paths: the API refuses
            # a start itself, with a redirect back to the app or the panel,
            # where the edge's 429 would leave a JSON page in the system
            # browser (ADR-026 §4). A flood of them reaches the box, whose
            # doors refuse it before anything is written or signed.
            dynamic "statement" {
              for_each = local.edge.uncounted
              content {
                not_statement {
                  statement {
                    byte_match_statement {
                      search_string         = statement.value
                      positional_constraint = "EXACTLY"

                      field_to_match {
                        uri_path {}
                      }

                      text_transformation {
                        priority = 0
                        type     = "NONE"
                      }
                    }
                  }
                }
              }
            }

            # The load runner's address, of the set above.
            statement {
              not_statement {
                statement {
                  ip_set_reference_statement {
                    arn = aws_wafv2_ip_set.unlimited.arn
                  }
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.edge_metric_name}-requests-per-address"
      sampled_requests_enabled   = false
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.edge_metric_name
    sampled_requests_enabled   = false
  }

  tags = { Name = local.edge_metric_name }
}
