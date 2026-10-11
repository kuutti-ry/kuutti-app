import { randomBytes } from "node:crypto";
import { ACR_LOATEST2 } from "@kuutti/tunnistus-oidc";
import { type FakeTelia, fakeTelia, TELIA_ISSUER } from "@kuutti/tunnistus-oidc/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { BrokerError } from "./broker.ts";
import { OidcBroker } from "./oidc-broker.ts";

// What the adapter adds to the kit (ADR-017): the dialect itself is proven in
// packages/tunnistus-oidc; here only Kuutti's part of a login is checked.

const random = () => randomBytes(24).toString("base64url");

async function brokerFor(telia: FakeTelia) {
  return OidcBroker.create({
    issuer: TELIA_ISSUER,
    clientId: telia.clientId,
    redirectUri: telia.redirectUri,
    acrValues: ACR_LOATEST2,
    signingKeyPem: telia.signingKeyPem,
    encryptionKeyPem: telia.encryptionKeyPem,
    fetch: telia.fetch,
  });
}

async function login(broker: OidcBroker, telia: FakeTelia) {
  const state = random();
  const nonce = random();
  const back = await telia.authorize(await broker.startLogin({ state, nonce, locale: "fi" }));
  return broker.completeLogin({ callbackUrl: back, state, nonce });
}

describe("OidcBroker, the adapter over @kuutti/tunnistus-oidc", () => {
  let telia: FakeTelia;
  beforeEach(async () => {
    telia = await fakeTelia();
  });

  it("asks the bank every time (ADR-016) and keeps of the answer what the callback may hold, no name or date of birth", async () => {
    const broker = await brokerFor(telia);
    const answer = await login(broker, telia);
    expect(telia.seen.requestObject).toMatchObject({ prompt: "login", ui_locales: "fi" });
    expect(answer).toMatchObject({
      hetu: "010170-999R",
      subject: "2BY5CDNFBEOSUFSKNGFSY4Y3DZISGL4I",
      acr: ACR_LOATEST2,
    });
    expect(Object.keys(answer).sort()).toEqual(
      ["acr", "amr", "authenticatedAt", "hetu", "sessionIndex", "subject", "tokenId"].sort(),
    );
    expect(JSON.stringify(answer)).not.toContain("Äyrämö");
    expect(JSON.stringify(answer)).not.toContain("1970-01-01");
  });

  it("turns the kit's refusal into the API's error with the reason as its detail", async () => {
    const broker = await brokerFor(telia);
    telia.misbehave = { omitHetu: true };
    await expect(login(broker, telia)).rejects.toBeInstanceOf(BrokerError);
    telia.misbehave = { omitHetu: true };
    await expect(login(broker, telia)).rejects.toMatchObject({
      detail: { detail: "no identity code" },
    });
  });

  it("does not boot against a Telia issuer without both keys, naming the parameters", async () => {
    await expect(
      OidcBroker.create({
        issuer: TELIA_ISSUER,
        clientId: telia.clientId,
        redirectUri: telia.redirectUri,
        acrValues: ACR_LOATEST2,
        signingKeyPem: telia.signingKeyPem,
        encryptionKeyPem: null,
        fetch: telia.fetch,
      }),
    ).rejects.toThrow(/TELIA_SIGNING_KEY and TELIA_ENCRYPTION_KEY/);
  });
});
