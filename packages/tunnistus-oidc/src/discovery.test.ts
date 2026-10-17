import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DiscoveryError, discoverProvider, isOnTeliaHost, isTeliaIssuer } from "./discovery.ts";

const SEEDED = { seed: 20261011 };

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

  it("waits for the document no longer than it was told, through an abort signal", async () => {
    let seen: AbortSignal | undefined;
    await discoverProvider(
      issuer,
      async (_url, init) => {
        seen = init?.signal;
        return Response.json(document);
      },
      250,
    );
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
    const slow = (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    await expect(discoverProvider(issuer, slow, 1)).rejects.toThrow(
      /^OpenID discovery for https:\/\/tunnistus-pp\.telia\.fi\/uas failed: The operation was aborted due to timeout$/,
    );
  });

  it("names the failure of a fetch that throws something other than an Error", async () => {
    const throwing = async (): Promise<Response> => {
      throw "socket hang up";
    };
    await expect(discoverProvider(issuer, throwing)).rejects.toThrow(
      `OpenID discovery for ${issuer} failed: socket hang up`,
    );
  });

  it("refuses a body that is not JSON", async () => {
    const html = async () =>
      new Response("<html>Huoltokatko</html>", { headers: { "content-type": "text/html" } });
    await expect(discoverProvider(issuer, html)).rejects.toThrow(
      `metadata is not a provider document (${issuer}/.well-known/openid-configuration)`,
    );
  });

  it.each(["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"])(
    "refuses a document without %s, or with one that is not a URL",
    async (field) => {
      const { [field as keyof typeof document]: _gone, ...without } = document;
      await expect(discoverProvider(issuer, answering(200, without))).rejects.toThrow(
        /not a provider document/,
      );
      await expect(
        discoverProvider(issuer, answering(200, { ...document, [field]: "oauth2/token" })),
      ).rejects.toThrow(/not a provider document/);
    },
  );

  it("refuses the optional lists when they are not lists of strings", async () => {
    for (const field of ["token_endpoint_auth_methods_supported", "acr_values_supported"]) {
      await expect(
        discoverProvider(issuer, answering(200, { ...document, [field]: "private_key_jwt" })),
      ).rejects.toThrow(/not a provider document/);
      await expect(
        discoverProvider(issuer, answering(200, { ...document, [field]: [1, 2] })),
      ).rejects.toThrow(/not a provider document/);
    }
  });

  it("refuses a Telia document that does not offer private_key_jwt (guide 2.6), and asks it of no other provider", async () => {
    const { token_endpoint_auth_methods_supported: _methods, ...bare } = document;
    for (const withoutIt of [
      bare,
      { ...document, token_endpoint_auth_methods_supported: [] },
      { ...document, token_endpoint_auth_methods_supported: ["client_secret_basic", "none"] },
    ]) {
      await expect(discoverProvider(issuer, answering(200, withoutIt))).rejects.toThrow(
        `OpenID discovery for ${issuer} failed: no private_key_jwt at the token endpoint`,
      );
    }
    const mock = "http://127.0.0.1:8080/ftn";
    const mockDocument = { ...bare, issuer: mock };
    await expect(discoverProvider(mock, async () => Response.json(mockDocument))).resolves.toEqual(
      mockDocument,
    );
  });

  it("returns the fields it checks and drops the rest", async () => {
    const metadata = await discoverProvider(
      issuer,
      answering(200, { ...document, acr_values_supported: ["x"], scopes_supported: ["openid"] }),
    );
    expect(metadata).toEqual({ ...document, acr_values_supported: ["x"] });
  });

  it("compares the issuer character for character: case and a trailing slash in the document count", async () => {
    for (const named of [`${issuer}/`, issuer.toUpperCase(), issuer.replace("https", "http")]) {
      const error = await discoverProvider(
        issuer,
        answering(200, { ...document, issuer: named }),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DiscoveryError);
      expect((error as DiscoveryError).message).toBe(
        `OpenID discovery for ${issuer} failed: document names issuer ${named}`,
      );
    }
  });

  it("carries the configured issuer on its error", async () => {
    const error = await discoverProvider(`${issuer}/`, answering(503, {})).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscoveryError);
    expect(error).toMatchObject({ name: "DiscoveryError", issuer: `${issuer}/` });
  });

  it("takes the host the URL names, over https only: no other scheme, host or port counts as Telia's", () => {
    for (const other of [
      "http://tunnistus.telia.fi/uas",
      "http://TUNNISTUS-PP.telia.fi:443/uas",
      "https://tunnistus.telia.fi:8443/uas",
      "https://evil.tunnistus.telia.fi/uas",
      "https://tunnistus-pp.telia.fi.example/uas",
      "https://tunnistus.telia.fi@evil.example/uas",
      "https://tunnistus-qa.telia.fi/uas",
      "tunnistus.telia.fi/uas",
      "",
    ]) {
      expect(isTeliaIssuer(other), other).toBe(false);
    }
    for (const telia of [
      "https://tunnistus.telia.fi/",
      "https://tunnistus.telia.fi",
      "https://TUNNISTUS.telia.fi/uas",
      "https://tunnistus.telia.fi:443/uas",
      "https://Tunnistus-PP.Telia.FI:443/uas",
      "https://tunnistus-pp.telia.fi./uas",
      " https://tunnistus.telia.fi/uas",
    ]) {
      expect(isTeliaIssuer(telia), telia).toBe(true);
    }
  });

  it("tells Telia's host whatever the scheme or port, and no other host", () => {
    for (const telia of [
      "https://tunnistus.telia.fi/uas",
      "http://tunnistus.telia.fi/uas",
      "https://TUNNISTUS-PP.telia.fi:8443/uas",
      "http://tunnistus-pp.telia.fi.:80/",
    ]) {
      expect(isOnTeliaHost(telia), telia).toBe(true);
    }
    for (const other of [
      "https://tunnistus.telia.fi.example/uas",
      "https://tunnistus.telia.fi@evil.example/uas",
      "http://127.0.0.1:8080/ftn",
      "tunnistus.telia.fi/uas",
      "",
    ]) {
      expect(isOnTeliaHost(other), other).toBe(false);
    }
  });

  it("takes no URL on another host for Telia's, and any path on Telia's two in any case and on the default port (property)", () => {
    fc.assert(
      fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), (url) => {
        const { hostname, port, protocol } = new URL(url);
        expect(isTeliaIssuer(url)).toBe(
          protocol === "https:" &&
            port === "" &&
            ["tunnistus.telia.fi", "tunnistus-pp.telia.fi"].includes(hostname),
        );
      }),
      SEEDED,
    );
    fc.assert(
      fc.property(
        fc.constantFrom("tunnistus.telia.fi", "tunnistus-pp.telia.fi"),
        fc.array(fc.boolean(), { minLength: 21, maxLength: 21 }),
        fc.constantFrom("", ":443"),
        fc.webPath(),
        (host, capitals, port, path) => {
          const spelled = [...host].map((c, i) => (capitals[i] ? c.toUpperCase() : c)).join("");
          expect(isTeliaIssuer(`https://${spelled}${port}/${path.replace(/^\//, "")}`)).toBe(true);
          expect(isTeliaIssuer(`http://${spelled}${port}/${path.replace(/^\//, "")}`)).toBe(false);
        },
      ),
      SEEDED,
    );
  });
});
