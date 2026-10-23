/**
 * Drives the authorization-code flow against the local mock IdP without a
 * browser: the login page is ours and names every persona, a persona's claims
 * come back in the ID token as the bank would say them, and so do the claims
 * of anybody else typed into the form. One more login goes through the Telia
 * kit's client in its plain dialect, the way the API logs in here (#426): the
 * kit's own test of that skips where no mock runs, so CI's compose job is
 * where the dialect meets the real mock on every pull request.
 *
 *   node services/mock-idp/verify.ts [issuer]   (default http://127.0.0.1:8080/ftn)
 *
 * No dependencies but the personas and the kit. Exit 1 on any mismatch.
 */
import { randomBytes } from "node:crypto";
import { createTunnistusClient, FTN_CLAIMS } from "@kuutti-ry/tunnistus-oidc";
import {
  DEMO_PERSONAS,
  MOCK_BANK_ACR,
  personaClaims,
} from "../../packages/db/src/seed/personas.ts";

const issuer = (process.argv[2] ?? process.env.OIDC_ISSUER ?? "http://127.0.0.1:8080/ftn").replace(
  /\/$/,
  "",
);
// The client as env.example gives it to the API.
const clientId = "kuutti-local";
const redirectUri = "http://localhost:3000/auth/callback";
// The claim names the Telia broker uses for a Finnish user (docs/vendors/telia.md,
// guide 2.6.4): the hetu and the date of birth under their OIDs, the FTN
// pre-production acr, the bank as an amr URI. An artificial code (individual
// number 900 to 999), never a person's.
const somebody = {
  "urn:oid:1.2.246.21": "010190-999W",
  "urn:oid:1.3.6.1.5.5.7.9.1": "1990-01-01",
  "urn:oid:2.5.4.4": "Henkilö",
  "urn:oid:1.2.246.575.1.14": "Testi",
  "urn:oid:2.16.840.1.113730.3.1.241": "Testi Henkilö",
  acr: "http://ftn.ficora.fi/2017/loatest2",
  amr: ["https://tunnistus-pp.telia.fi/uas/saml2/names/ac/oidc.mock.1"],
};

function fail(msg: string): never {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

async function waitForDiscovery(): Promise<{
  authorization_endpoint: string;
  token_endpoint: string;
}> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok)
        return (await res.json()) as { authorization_endpoint: string; token_endpoint: string };
    } catch {}
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return fail(`no discovery document at ${issuer} within 60 s`);
}

const discovery = await waitForDiscovery();
console.log(`✔ discovery: ${discovery.authorization_endpoint}`);

function authorizeUrl(state: string, nonce: string): URL {
  const authorize = new URL(discovery.authorization_endpoint);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "openid",
    state,
    nonce,
  }).toString();
  return authorize;
}

// Step 1: the login page. It is the one generated from the personas
// (loginPagePath), so every persona has its button.
const page = await fetch(authorizeUrl("state-0", "nonce-0"), { redirect: "manual" });
if (page.status !== 200) fail(`authorize did not show the login page: ${page.status}`);
const html = await page.text();
for (const persona of DEMO_PERSONAS) {
  if (!html.includes(`data-persona="${persona.key}"`))
    fail(`the login page has no button for ${persona.key}: is login.html mounted and current?`);
}
if (
  !/charset=utf-8/i.test(page.headers.get("content-type") ?? "") &&
  !/<meta charset="utf-8"/.test(html)
)
  fail("the login page does not say it is UTF-8");
console.log(`✔ login page: ${DEMO_PERSONAS.length} personas`);

/**
 * The browser's part: the mock's login form, posted back as the page does it,
 * with the claims of the person. The answer is the redirect to the callback.
 */
async function postLoginForm(
  authorize: URL,
  username: string,
  claims: Record<string, unknown>,
): Promise<URL> {
  const posted = await fetch(authorize, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, claims: JSON.stringify(claims) }).toString(),
  });
  if (posted.status < 300 || posted.status >= 400)
    fail(`${username}: login did not redirect: ${posted.status} ${await posted.text()}`);
  return new URL(posted.headers.get("location") ?? fail("login redirect has no Location"));
}

/** Step 2 and 3: post the form, then trade the code for the ID token and read it raw. */
async function login(
  username: string,
  claims: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const state = `state-${username}`;
  const nonce = `nonce-${username}`;
  const back = await postLoginForm(authorizeUrl(state, nonce), username, claims);
  const code = back.searchParams.get("code") ?? fail(`no code in ${back.href}`);
  if (back.searchParams.get("state") !== state) fail(`${username}: state mismatch`);

  const token = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: "unused",
    }).toString(),
  });
  if (!token.ok) fail(`${username}: token endpoint ${token.status}: ${await token.text()}`);
  const { id_token: idToken } = (await token.json()) as { id_token?: string };
  if (!idToken) fail(`${username}: no id_token in the token response`);
  const payload = JSON.parse(
    Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;

  for (const [key, expected] of Object.entries(claims)) {
    const actual = payload[key];
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      fail(
        `${username}: claim ${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
  }
  if (payload.nonce !== nonce) fail(`${username}: nonce ${String(payload.nonce)}`);
  if (payload.iss !== issuer) fail(`${username}: iss ${String(payload.iss)}, expected ${issuer}`);
  if (payload.sub !== username) fail(`${username}: sub ${String(payload.sub)}`);
  return payload;
}

// Every persona, as its button posts it today. Names with å, ä and ö come back as they went.
const today = new Date();
for (const persona of DEMO_PERSONAS) {
  await login(persona.key, personaClaims(persona, today));
}
console.log(`✔ personas: ${DEMO_PERSONAS.map((p) => p.key).join(", ")}`);

const payload = await login("testi", somebody);
console.log(
  `✔ somebody else: ${Object.keys(somebody).join(", ")} (iss ${String(payload.iss)}, sub ${String(payload.sub)})`,
);

// Step 4: one login through the Telia kit's client, in the plain dialect the
// mock's http issuer selects (ADR-017 §3): the kit discovers the mock, builds
// the authorization URL, exchanges the code, verifies the ID token against the
// mock's JWKS and types the FTN claims. The level is the one env.example has
// the API ask for, which the personas answer.
const kit = await createTunnistusClient({
  issuer,
  clientId,
  redirectUri,
  acrValues: MOCK_BANK_ACR,
  signingKeyPem: null,
  encryptionKeyPem: null,
});
if (kit.dialect !== "plain") fail(`the kit took the ${kit.dialect} dialect for ${issuer}`);
// Kerttu: a name with Å, so the typed answer is checked for UTF-8 as well.
const persona = DEMO_PERSONAS.find((p) => p.key === "kerttu") ?? fail("no persona kerttu");
const claims = personaClaims(persona, today);
const state = randomBytes(24).toString("base64url");
const nonce = randomBytes(24).toString("base64url");
const authorize = await kit.startLogin({ state, nonce, uiLocales: "fi", prompt: "login" });
const back = await postLoginForm(authorize, persona.key, claims);
const identity = await kit
  .completeLogin({ callbackUrl: back, state, nonce })
  .catch((error: unknown) =>
    fail(
      `${persona.key} through the kit: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
const expected = {
  personalIdentityCode: claims[FTN_CLAIMS.personalIdentityCode],
  dateOfBirth: claims[FTN_CLAIMS.dateOfBirth],
  givenNames: claims[FTN_CLAIMS.givenNames],
  surname: claims[FTN_CLAIMS.surname],
  displayName: claims[FTN_CLAIMS.displayName],
  acr: claims.acr,
  amr: claims.amr,
  subject: persona.key,
};
for (const [key, value] of Object.entries(expected)) {
  const actual = identity[key as keyof typeof expected];
  if (JSON.stringify(actual) !== JSON.stringify(value))
    fail(
      `${persona.key} through the kit: ${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual)}`,
    );
}
console.log(
  `✔ the kit's client, plain dialect: ${persona.key} (acr ${identity.acr}, amr ${identity.amr.join(" ")})`,
);
