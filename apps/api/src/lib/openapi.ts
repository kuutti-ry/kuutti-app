/**
 * The document served at /openapi.json outside production and written to
 * apps/api/openapi.json by `pnpm openapi`, from which packages/schema's typed
 * paths are generated (ADR-003). The version is the package version, not the
 * build, so the committed file stays stable between releases.
 */
export function openApiDocument(version: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Kuutti API",
      version,
      description:
        "Free, non-commercial dating app for Finland. Every account is verified through a Finnish bank. Source: AGPL-3.0 with App Store exception.",
    },
  };
}

/**
 * The generator writes a nullable union in OpenAPI 3.0's way, a bare
 * `{ nullable: true }` among its members, which openapi-typescript reads as
 * `unknown` and so widens the whole union. In the 3.1 document this is, that
 * member is the null type: `{ type: "null" }` (a conversation that ended names
 * nobody, #351).
 */
export function nullMembers(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(nullMembers);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] =
      (key === "oneOf" || key === "anyOf") && Array.isArray(value)
        ? value.map((member) =>
            JSON.stringify(member) === '{"nullable":true}' ? { type: "null" } : nullMembers(member),
          )
        : nullMembers(value);
  }
  return out;
}

/**
 * The document as served at /openapi.json and written by `pnpm openapi`:
 * one function, so the two never differ.
 */
export function servedDocument(
  app: { getOpenAPIDocument: (config: ReturnType<typeof openApiDocument>) => unknown },
  version: string,
): unknown {
  return nullMembers(app.getOpenAPIDocument(openApiDocument(version)));
}
