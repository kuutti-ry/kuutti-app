import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { Queryable } from "@kuutti/db";
import { DEMO_PERSONAS, MOCK_BANK_AMR } from "@kuutti/db/demo";
import { PHOTO_VARIANTS } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { createS3Client } from "../../src/lib/s3.ts";
import { type MediaDeps, memoryMediaStore, objectKey } from "../../src/media/index.ts";
import { attack } from "../../src/test/attack.ts";
import { STOPPED_CLOCK } from "../../src/test/global-setup.ts";
import { captureLogger, testConfig, testPool } from "../../src/test/harness.ts";
import { DemoError, type Fetch, loginAs, onThisComputer, whyNotTheLocalStore } from "./bank.ts";
import { resetPersonas } from "./reset.ts";

// Attacks on what the demo commands look at before they act, and on whom the
// reset forgets (#380; #73, ADR-014 §12, ADR-018). The addresses are asked of
// the functions and nothing is dialled; the reset runs in a transaction of the
// test database that is rolled back, against a store in memory.

const MARK = "kuutti380mark";
const now = () => STOPPED_CLOCK;

describe("an address that is not this computer's", () => {
  const OWN = ["127.0.0.1", "::1", "192.168.1.20"];
  const store = (endpoint: string, bucket = "kuutti-media") => ({
    taken: whyNotTheLocalStore({ endpoint, bucket, pathStyle: true }, OWN) === null,
  });
  const taken = (seen: { taken: boolean }) => expect(seen.taken).toBe(true);

  // Each row is another machine in a spelling that names this one somewhere; its control is this one.
  for (const [how, elsewhere, here] of [
    [
      "has a loopback address before an @",
      "http://127.0.0.1@192.0.2.10:9000",
      "http://192.0.2.10@127.0.0.1:9000",
    ],
    [
      "is a name that begins with a loopback address",
      "http://127.0.0.1.example.org:9000",
      "http://127.0.0.1:9000",
    ],
    [
      "is one of this computer's addresses with a digit more",
      "http://192.168.1.200:9000",
      "http://192.168.1.20:9000",
    ],
    [
      "is a name that begins with one of this computer's addresses",
      "http://192.168.1.20.example.org:9000",
      "http://192.168.1.20:9000",
    ],
  ] as const) {
    attack(`the object store: an address that ${how} is taken for the stand-in on this computer`, {
      attempt: () => store(elsewhere),
      control: () => store(here),
      succeeds: taken,
    });
  }

  for (const [how, elsewhere, here] of [
    [
      "has localhost before an @",
      "http://localhost@192.0.2.10:3000",
      "http://192.0.2.10@localhost:3000",
    ],
    [
      "is a name that begins with localhost",
      "http://localhost.example.org:3000",
      "http://localhost:3000",
    ],
  ] as const) {
    attack(`the API and the bank: an address that ${how} is taken for this computer`, {
      attempt: () => ({ taken: onThisComputer(new URL(elsewhere)) }),
      control: () => ({ taken: onThisComputer(new URL(here)) }),
      succeeds: taken,
    });
  }

  /** The host the API's own client sends a request for this bucket to; the request is stopped before any socket. */
  async function dialled(bucket: string): Promise<string> {
    const client = createS3Client(
      testConfig({
        S3_ENDPOINT: "http://127.0.0.1:9000",
        S3_FORCE_PATH_STYLE: "true",
        S3_ACCESS_KEY: "stand-in",
        S3_SECRET_KEY: "stand-in",
      }),
    );
    let host = "";
    client.config.requestHandler = {
      handle: async (request: { hostname: string }) => {
        host = request.hostname;
        throw new Error("stopped before any socket");
      },
    } as unknown as typeof client.config.requestHandler;
    await client
      .send(new GetObjectCommand({ Bucket: bucket, Key: objectKey("c".repeat(64), "thumb") }))
      .catch(() => undefined);
    return host;
  }
  // A bucket's alias on an Outpost, as AWS writes one: the client goes to AWS for it, whatever the endpoint says.
  const OUTPOST_ALIAS = "test-o01ac5d28a6a232904e8xz5w8ijx1qzlbp3i3kuse10--op-s3";

  attack(
    "the object store: a bucket the client goes to AWS for, whatever the endpoint says, is taken for the stand-in on this computer",
    {
      attempt: async () => {
        // The attack's own ground: for this bucket the client does leave this computer, and for the usual one it does not.
        expect(await dialled("kuutti-media")).toBe("127.0.0.1");
        expect(await dialled(OUTPOST_ALIAS)).toMatch(/\.amazonaws\.com$/);
        return store("http://127.0.0.1:9000", OUTPOST_ALIAS);
      },
      control: () => store("http://127.0.0.1:9000"),
      succeeds: taken,
    },
  );
});

describe("the walk to the bank and back", () => {
  const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
  /** A sign-in walked against an API at `api` whose bank is the mock on this computer; every answer is scripted. */
  const walked = (api: string) => {
    const routes: Record<string, () => Response> = {
      "GET /auth/start": () => redirect("http://127.0.0.1:8080/ftn/authorize?state=state-1"),
      "POST /ftn/authorize": () => redirect(`${api}/auth/callback?code=bank-code&state=state-1`),
      "GET /auth/callback": () => redirect(`kuutti://auth?code=${"c".repeat(43)}`),
      "POST /auth/exchange": () =>
        Response.json({
          outcome: "created",
          sessionId: "6f1c2b9e-7a4d-4c3b-9e8f-0a1b2c3d4e5f",
          accessToken: "T".repeat(43),
          accessExpiresAt: "2026-10-16T09:15:00.000Z",
          refreshToken: `${"F".repeat(43)}.${"R".repeat(43)}`,
          refreshExpiresAt: "2026-11-15T09:00:00.000Z",
        }),
    };
    const fetch: Fetch = async (input, init) => {
      const route = `${init?.method ?? "GET"} ${new URL(input).pathname}`;
      const answer = routes[route];
      if (!answer) throw new Error(`nothing scripted for ${route}`);
      return answer();
    };
    const persona = DEMO_PERSONAS[0] as (typeof DEMO_PERSONAS)[number];
    return loginAs(persona, { api, fetch, now }).then(
      (login) => ({ signedIn: login.kind === "session" }),
      (error: unknown) => {
        if (
          !(error instanceof DemoError) ||
          error.message !== "the personas need an API on this computer: nothing was sent"
        )
          throw error;
        return { signedIn: false };
      },
    );
  };

  // scripts/e2e.ts signs Ville in through this walk at whatever E2E_API_URL names.
  attack("the walk to the bank: a persona is signed in at an API that is not on this computer", {
    attempt: () => walked("http://192.0.2.10:3000"),
    control: () => walked("http://127.0.0.1:3000"),
    succeeds: (seen) => expect(seen.signedIn).toBe(true),
  });
});

/** One transaction of the test database for a run, rolled back whatever it did. */
async function rolledBack<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await testPool().connect();
  await client.query("BEGIN");
  try {
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/** Somebody as a login leaves them: an identity by what the bank called it, and a live account. */
async function made(
  db: Queryable,
  who: { subject: string; amr?: string; hash?: string },
): Promise<{ accountId: string }> {
  const identity = await db.query<{ id: string }>(
    `INSERT INTO identity (hetu_hmac, broker_subject, acr, amr)
     VALUES ($1, $2, 'x', ARRAY[$3]) RETURNING id`,
    [who.hash ?? `a hash for ${who.subject}`, who.subject, who.amr ?? MOCK_BANK_AMR],
  );
  const account = await db.query<{ id: string }>(
    `INSERT INTO account (identity_id, state, birth_year, birth_month)
     VALUES ($1, 'active', 1997, 3) RETURNING id`,
    [identity.rows[0]?.id],
  );
  const accountId = account.rows[0]?.id;
  if (!accountId) throw new Error("nobody written");
  return { accountId };
}

const stillHere = async (db: Queryable, accountId: string) =>
  (await db.query("SELECT 1 FROM account WHERE id = $1 AND state = 'active'", [accountId]))
    .rowCount === 1;

describe("whom the reset forgets", () => {
  const forgotten = (
    who: Parameters<typeof made>[1],
    personas?: ReadonlyMap<string, string>,
  ): Promise<{ forgotten: boolean }> =>
    rolledBack(async (db) => {
      const { logger } = await captureLogger();
      const { accountId } = await made(db, who);
      await resetPersonas({ db, logger, now, ...(personas ? { personas } : {}) });
      return { forgotten: !(await stillHere(db, accountId)) };
    });
  const isForgotten = (seen: { forgotten: boolean }) => expect(seen.forgotten).toBe(true);

  // Each row is somebody who is no persona of the mock bank; the control is Aino herself.
  for (const [how, who] of [
    ["whose name begins with a persona's", { subject: "aino-maria" }],
    ["with a persona's name in capitals", { subject: "AINO" }],
    [
      "with a persona's name, at a bank whose mark begins with the mock bank's",
      { subject: "aino", amr: `${MOCK_BANK_AMR}.2` },
    ],
  ] as const) {
    attack(`demo:reset: somebody ${how} is forgotten with the personas`, {
      attempt: () => forgotten(who),
      control: () => forgotten({ subject: "aino" }),
      succeeds: isForgotten,
    });
  }

  // On staging the personas are known by their hash (ADR-018): two that differ in the last digit alone.
  const HASH = "a".repeat(63);
  attack(
    "demo:reset on staging: somebody whose hash differs from a persona's in its last digit is forgotten",
    {
      attempt: () => forgotten({ subject: "x", hash: `${HASH}2` }, new Map([[`${HASH}1`, "aino"]])),
      control: () => forgotten({ subject: "x", hash: `${HASH}1` }, new Map([[`${HASH}1`, "aino"]])),
      succeeds: isForgotten,
    },
  );
});

describe("what the reset deletes and leaves", () => {
  const photoOf = (db: Queryable, accountId: string, content: string) =>
    db.query(
      `INSERT INTO photo (account_id, key, blurhash, width, height, position)
       VALUES ($1, $2, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 1200, 1600, 0)`,
      [accountId, content],
    );
  const storeWith = async (...contents: string[]) => {
    const store = memoryMediaStore();
    for (const content of contents) {
      for (const variant of PHOTO_VARIANTS) {
        await store.put(objectKey(content, variant), new Uint8Array([1]), "image/webp");
      }
    }
    return store;
  };
  const media = (store: unknown) => ({ store }) as unknown as MediaDeps;
  /** The reset's own refusals are an outcome here; anything else is the test's. */
  const refusal = (error: unknown): string => {
    if (!(error instanceof DemoError)) throw error;
    return error.message;
  };
  const C = "c".repeat(64);
  const D = "d".repeat(64);

  /** Aino's reset, her one picture in the store; `shared`: somebody who is no persona shows the same picture. */
  const pictureAfterTheReset = (shared: boolean) =>
    rolledBack(async (db) => {
      const { logger } = await captureLogger();
      await photoOf(db, (await made(db, { subject: "aino" })).accountId, C);
      if (shared) await photoOf(db, (await made(db, { subject: "somebody" })).accountId, C);
      const store = await storeWith(C);
      await resetPersonas({ db, logger, now, media: media(store) }).catch(refusal);
      return { gone: store.objects.size === 0 };
    });

  attack(
    "demo:reset: a picture somebody who is no persona still shows has its objects deleted with the persona's",
    {
      attempt: () => pictureAfterTheReset(true),
      control: () => pictureAfterTheReset(false),
      succeeds: (seen) => expect(seen.gone).toBe(true),
    },
  );

  /** Two personas with a picture each; `fails`: the store deletes for the first erased and fails for the second. */
  const erasedAfterTheReset = (fails: boolean) =>
    rolledBack(async (db) => {
      const { logger } = await captureLogger();
      const aino = await made(db, { subject: "aino" });
      const mikael = await made(db, { subject: "mikael" });
      await photoOf(db, aino.accountId, C);
      await photoOf(db, mikael.accountId, D);
      const store = await storeWith(C, D);
      let deletions = 0;
      const second = {
        ...store,
        delete: async (keys: string[]) => {
          deletions += 1;
          if (fails && deletions > 1) throw new Error("DeleteObjects left 3 of 3 objects");
          return store.delete(keys);
        },
      };
      const said = await resetPersonas({ db, logger, now, media: media(second) }).then(
        () => "",
        refusal,
      );
      // The setup's own check: the reset ended as this run means it to.
      expect(said).toMatch(fails ? /were not deleted/ : /^$/);
      const here = [await stillHere(db, aino.accountId), await stillHere(db, mikael.accountId)];
      return { erased: here.filter((live) => !live).length };
    });

  attack("demo:reset: a reset that failed at the second persona leaves the first one erased", {
    attempt: () => erasedAfterTheReset(true),
    control: () => erasedAfterTheReset(false),
    succeeds: (seen) => expect(seen.erased).toBeGreaterThan(0),
  });

  /** The reset's refusal when the store does not answer, the mark in the error's message or in its name. */
  const saidOfTheStore = (where: "message" | "name") =>
    rolledBack(async (db) => {
      const { logger } = await captureLogger();
      await photoOf(db, (await made(db, { subject: "aino" })).accountId, C);
      const silent = {
        get: async () => {
          throw Object.assign(
            new Error(where === "message" ? `no answer from ${MARK}` : "no answer"),
            {
              name: where === "name" ? MARK : "TimeoutError",
            },
          );
        },
      };
      return resetPersonas({ db, logger, now, media: media(silent) }).then(() => "", refusal);
    });

  attack(
    "demo:reset: a store that does not answer has what its error said repeated in the refusal",
    {
      attempt: () => saidOfTheStore("message"),
      // The error's name is what the refusal says, on purpose.
      control: () => saidOfTheStore("name"),
      succeeds: (seen) => expect(seen).toContain(MARK),
    },
  );
});
