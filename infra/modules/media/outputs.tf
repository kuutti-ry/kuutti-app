output "bucket" {
  description = "SSM parameter s3-bucket: the API's S3_BUCKET."
  value       = aws_s3_bucket.media.bucket
}

output "bucket_arn" {
  description = "For modules/research: the research copy lives in this bucket (#194, ADR-029)."
  value       = aws_s3_bucket.media.arn
}

output "research_prefix" {
  description = "Where in the bucket the research copy lives; the lifecycle rule moves it to Glacier Instant Retrieval after a year (#194, ADR-029 §8)."
  value       = local.research_prefix
}

output "media_url_base" {
  description = "SSM parameter media-url-base: the API's MEDIA_URL_BASE, the distribution's name; objects are signed under /media/."
  value       = "https://${var.api_fqdn}"
}

output "key_pair_id" {
  description = "SSM parameter cloudfront-key-pair-id: the API's CLOUDFRONT_KEY_PAIR_ID, the id of the current public key (Key-Pair-Id in every signed URL)."
  value       = aws_cloudfront_public_key.signing[local.current_signing_key].id
}

output "trusted_key_ids" {
  description = "Every public key the media behaviour trusts, by the hash that names it; the current one is key_pair_id."
  value       = { for hash, key in aws_cloudfront_public_key.signing : hash => key.id }
}

output "distribution_id" {
  value = aws_cloudfront_distribution.this.id
}

output "distribution_domain_name" {
  value = aws_cloudfront_distribution.this.domain_name
}

output "certificate_arn" {
  value = aws_acm_certificate_validation.api.certificate_arn
}
