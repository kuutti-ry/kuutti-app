// Kuutti's distribution proves itself to the box (ADR-066). On every request
// of the default behaviour (the API, Dokploy, the previews) it sets
// x-kuutti-origin to the store's one value, origin-secret, which the API
// compares with its own copy before it believes CloudFront's viewer address.
// A viewer's own x-kuutti-origin never passes. While the store has no key
// (written by hand, infra/README.md, Media) the request goes without one,
// which matters only where the API trusts the viewer address: there it has
// no address. Templated by OpenTofu: the store's id is filled in, never the
// value, which is in no state (ADR-001).
import cf from "cloudfront";

// biome-ignore lint/suspicious/noTemplateCurlyInString: OpenTofu's templatefile() fills it in, not JavaScript
const store = cf.kvs("${store_id}");

// biome-ignore lint/correctness/noUnusedVariables: CloudFront calls the function named handler
async function handler(event) {
  const request = event.request;
  delete request.headers["x-kuutti-origin"];
  try {
    request.headers["x-kuutti-origin"] = { value: await store.get("origin-secret") };
  } catch (_missing) {
    // No key yet: the request goes on without the proof.
  }
  return request;
}
