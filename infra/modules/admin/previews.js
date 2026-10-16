// The panel's previews (#313, ADR-025 §6), a CloudFront Function
// (cloudfront-js-2.0) on the viewer requests of the `pr-*` behaviour alone.
// A preview is the panel built under /pr-<n>/, and a path inside it whose
// last segment has no dot is one of its pages (no route of the panel holds a
// dot): it is answered with that preview's index.html, and the preview's
// router finds the page. An asset, or a path outside a preview, passes
// through untouched; the root has the distribution's own fallback (§2).

const PREVIEW = /^\/pr-(\d+)(\/.*)?$/;

// biome-ignore lint/correctness/noUnusedVariables: CloudFront calls the function named handler.
function handler(event) {
  const request = event.request;
  const match = PREVIEW.exec(request.uri);
  if (!match) return request;
  const rest = match[2] || "";
  const last = rest.slice(rest.lastIndexOf("/") + 1);
  if (!last.includes(".")) request.uri = `/pr-${match[1]}/index.html`;
  return request;
}
