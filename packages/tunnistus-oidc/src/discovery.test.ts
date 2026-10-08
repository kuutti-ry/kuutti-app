import { describe, expect, it } from "vitest";
import { DiscoveryError, discoverProvider, isTeliaIssuer } from "./discovery.ts";

const issuer = "https://tunnistus-pp.telia.fi/uas";
const document = {
  issuer,
  authorization_endpoint: `${issuer}/oauth2/authorization`,
  token_endpoint: `${issuer}/oauth2/token`,
  jwks_uri: `${issuer}/oauth2/metadata.jwks`,
  token_endpoint_auth_methods_supported: ["private_key_jwt"],
};

const answering =
  (status: number, body: unknown) =>
  async (url: string): Promise<Response> => {
    expect(url).toBe(`${issuer}/.well-known/openid-configuration`);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };

describe("OpenID discovery", () => {
  it("reads the broker's endpoints from its well-known document", async () => {
    const metadata = await discoverProvider(issuer, answering(200, document));
    expect(metadata.token_endpoint).toBe(`${issuer}/oauth2/token`);
    expect(metadata.jwks_uri).toBe(`${issuer}/oauth2/metadata.jwks`);
  });

  it("accepts a trailing slash in the configured issuer", async () => {
    const metadata = await discoverProvider(`${issuer}/`, answering(200, document));
    expect(metadata.issuer).toBe(issuer);
  });

  it("refuses a document that names another issuer", async () => {
    await expect(
      discoverProvider(issuer, answering(200, { ...document, issuer: "https://evil.example/uas" })),
    ).rejects.toThrow(DiscoveryError);
  });

  it("refuses an error status, a non-document and an unreachable issuer, naming the issuer", async () => {
    await expect(discoverProvider(issuer, answering(503, {}))).rejects.toThrow(/HTTP 503/);
    await expect(discoverProvider(issuer, answering(200, { hello: 1 }))).rejects.toThrow(
      /not a provider document/,
    );
    const unreachable = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    };
    await expect(discoverProvider(issuer, unreachable)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("knows Telia's hosts", () => {
    expect(isTeliaIssuer("https://tunnistus-pp.telia.fi/uas")).toBe(true);
    expect(isTeliaIssuer("https://tunnistus.telia.fi/uas")).toBe(true);
    expect(isTeliaIssuer("http://127.0.0.1:8080/ftn")).toBe(false);
    expect(isTeliaIssuer("https://tunnistus.telia.fi.example/uas")).toBe(false);
  });
});
