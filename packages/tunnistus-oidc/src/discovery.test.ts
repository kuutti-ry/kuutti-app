import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DiscoveryError, discoverProvider, isTeliaIssuer } from "./discovery.ts";

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

  it("refuses the optional lists when they are not lists of strings, and accepts them absent", async () => {
    for (const field of ["token_endpoint_auth_methods_supported", "acr_values_supported"]) {
      await expect(
        discoverProvider(issuer, answering(200, { ...document, [field]: "private_key_jwt" })),
      ).rejects.toThrow(/not a provider document/);
      await expect(
        discoverProvider(issuer, answering(200, { ...document, [field]: [1, 2] })),
      ).rejects.toThrow(/not a provider document/);
    }
    const { token_endpoint_auth_methods_supported: _methods, ...bare } = document;
    await expect(discoverProvider(issuer, answering(200, bare))).resolves.toEqual(bare);
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

  it("takes the host as written: no other scheme, host, port or spelling counts as Telia's", () => {
    for (const other of [
      "http://tunnistus.telia.fi/uas",
      "https://tunnistus.telia.fi",
      "https://TUNNISTUS.telia.fi/uas",
      "https://tunnistus.telia.fi:443/uas",
      "https://evil.tunnistus.telia.fi/uas",
      "https://tunnistus-pp.telia.fi.example/uas",
      "https://tunnistus.telia.fi@evil.example/uas",
      "https://tunnistus-qa.telia.fi/uas",
      " https://tunnistus.telia.fi/uas",
    ]) {
      expect(isTeliaIssuer(other)).toBe(false);
    }
    expect(isTeliaIssuer("https://tunnistus.telia.fi/")).toBe(true);
  });

  it("takes no URL on another host for Telia's, and any path on Telia's two (property)", () => {
    fc.assert(
      fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), (url) => {
        const { host, protocol } = new URL(url);
        const telia =
          protocol === "https:" && ["tunnistus.telia.fi", "tunnistus-pp.telia.fi"].includes(host);
        expect(isTeliaIssuer(url)).toBe(telia && url.startsWith(`https://${host}/`));
      }),
      SEEDED,
    );
    fc.assert(
      fc.property(
        fc.constantFrom("tunnistus.telia.fi", "tunnistus-pp.telia.fi"),
        fc.webPath(),
        (host, path) => {
          expect(isTeliaIssuer(`https://${host}/${path.replace(/^\//, "")}`)).toBe(true);
        },
      ),
      SEEDED,
    );
  });
});
