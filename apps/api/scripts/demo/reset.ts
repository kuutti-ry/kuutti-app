import { type Queryable, transaction } from "@kuutti/db";
import { DEMO_PERSONAS, deleteIdentities, MOCK_BANK_AMR } from "@kuutti/db/demo";
import { PHOTO_VARIANTS } from "@kuutti/schema";
import { type ErasureSummary, eraseAccount } from "../../src/identity/index.ts";
import type { Logger } from "../../src/lib/logger.ts";
import { type MediaDeps, objectKey } from "../../src/media/index.ts";
import { DemoError } from "./bank.ts";

/**
 * Returns the personas of the mock bank to people Kuutti has never seen
 * (#73, ADR-014 §12). In two steps, on purpose:
 *
 * 1. every live account of a persona goes through the erasure path, the same
 *    function the app's "delete my account" calls, so a reset exercises it:
 *    sessions, photos with their objects, profile, preferences, the research
 *    mapping, and the account row left as a tombstone;
 * 2. then what erasure keeps is deleted too: the tombstones, the consent
 *    rows, the identity with its count of deletions and its waiting time.
 *    Right for a persona, which is nobody; never done for a person.
 *
 * A persona is known by what the mock bank called it: the subject is the
 * persona's name and the bank is the mock one. The command that calls this
 * has asked the server what it is first (`assertDemoTarget`): none of this
 * ever runs against a deployed database.
 *
 * A persona that holds a staff row is left alone, whole: somebody made it a
 * moderator on this machine (the moderator's command line grants the role to
 * the identity that just logged in, which locally is a persona's button), and
 * what it then wrote into the audit log can never be deleted. Erasing it and
 * failing on the deletion afterwards would leave a persona no later reset
 * could repair, so the question is asked before anybody is erased.
 *
 * A staff session that has ended is no staff row: taking a role away marks
 * the sessions revoked and leaves the rows to the API's nightly sweep, which
 * a developer's machine seldom runs. The reset deletes a persona's ended
 * sessions itself, as the sweep would, so that a persona whose role was
 * taken away is reset at once.
 *
 * All of it is one transaction, and the personas' identity rows are locked
 * from the question to the deletion. Whatever makes a persona staff names
 * the identity by a foreign key, and writing such a row waits for that lock:
 * a role granted while the reset runs is either seen by the question or
 * finds the persona gone, never an erased account it then keeps from being
 * deleted. Everybody is reset or nobody is. The erasure deletes a photo's
 * objects before this transaction has ended, so a reset that fails after
 * that leaves rows without their objects; the next reset takes them.
 *
 * The rows of the photos are what names their objects, so no row goes
 * while its objects stay. Three questions hold that, and each stops the
 * reset with everybody as they were:
 *
 * - without an object store, a persona with photos is not erased;
 * - with one, the store is asked before anybody is erased whether it holds
 *   the photos. A store on this computer need not be the API's: in another
 *   one the deletion of what is not there succeeds, and the objects stay
 *   where they are. `objectsLost` goes ahead without the question, for
 *   objects that are gone for good;
 * - after each erasure the objects it deleted are counted. The erasure path
 *   forgives a store that fails, as it must for a person who leaves; a
 *   reset does not.
 *
 * On staging (#141, ADR-018) the personas are the test persons of Telia's
 * bed and are known by the hash the container derived from their artificial
 * codes, the same hash the bed's login finds them by; the mock bank's marks
 * mean nothing there. The caller hands the hashes in, by persona.
 */
export type ResetDeps = {
  db: Queryable;
  logger: Logger;
  now: () => Date;
  media?: MediaDeps;
  /** Go ahead although the store does not hold the photos' objects: they are lost. */
  objectsLost?: boolean;
  /** On staging: the personas by their hash (`personaHashes`); locally, left out, by what the mock bank called them. */
  personas?: ReadonlyMap<string, string>;
};

export type ResetResult = {
  identities: number;
  erased: number;
  objects: number;
  /** The personas left alone because they hold a staff row, by name. */
  spared: string[];
};

export async function resetPersonas(deps: ResetDeps): Promise<ResetResult> {
  // One instant for the question and for the deletion: a session is ended
  // for both or for neither, whatever the clock does in between.
  const at = deps.now();
  const who = deps.personas
    ? { clause: "i.hetu_hmac = ANY($1)", params: [[...deps.personas.keys()]] }
    : {
        clause: "i.broker_subject = ANY($1) AND $2 = ANY(i.amr)",
        params: [DEMO_PERSONAS.map((p) => p.key), MOCK_BANK_AMR],
      };
  const keyOf = (row: { subject: string; hash: string }): string =>
    deps.personas?.get(row.hash) ?? row.subject;
  return transaction(deps.db, async (tx) => {
    // FOR UPDATE, not less: it is the lock a foreign key's check waits for.
    await tx.query(
      `SELECT i.id FROM identity i WHERE ${who.clause} ORDER BY i.id FOR UPDATE`,
      who.params,
    );
    // A statement of its own, after the lock: it sees what was committed
    // while the lock was waited for.
    const { rows: identities } = await tx.query<{
      id: string;
      subject: string;
      hash: string;
      staff: boolean;
    }>(
      `SELECT i.id, i.broker_subject AS subject, i.hetu_hmac AS hash,
              (EXISTS (SELECT 1 FROM moderator_roles m WHERE m.identity_id = i.id)
               OR EXISTS (SELECT 1 FROM admin_session s WHERE s.identity_id = i.id
                          AND s.revoked_at IS NULL AND s.expires_at >= $${who.params.length + 1})
               OR EXISTS (SELECT 1 FROM audit_log a WHERE a.actor_identity_id = i.id)
               OR EXISTS (SELECT 1 FROM photo_review r WHERE r.decided_by = i.id)) AS staff
       FROM identity i WHERE ${who.clause}`,
      [...who.params, at],
    );
    const spared = [...new Set(identities.filter((r) => r.staff).map(keyOf))].sort();
    const ids = identities.filter((r) => !r.staff).map((r) => r.id);
    if (ids.length === 0) return { identities: 0, erased: 0, objects: 0, spared };

    const { rows: photoRows } = await tx.query<{
      subject: string;
      hash: string;
      account: string;
      content: string;
    }>(
      `SELECT DISTINCT i.broker_subject AS subject, i.hetu_hmac AS hash, a.id AS account, p.key AS content
       FROM photo p JOIN account a ON a.id = p.account_id JOIN identity i ON i.id = a.identity_id
       WHERE i.id = ANY($1) ORDER BY 1, 4`,
      [ids],
    );
    const photos = photoRows.map((r) => ({
      key: keyOf(r),
      account: r.account,
      content: r.content,
    }));
    const named = (rows: readonly { key: string }[]) =>
      [...new Set(rows.map((r) => r.key))].join(", ");
    if (!deps.media && photos.length > 0) {
      throw new DemoError(
        `no object store is configured, and there are photos of ${named(photos)}: their rows would go and their objects stay, with nothing left to find them by. Set S3_ENDPOINT to the stand-in (env.example) and reset again; nobody was erased`,
      );
    }
    if (deps.media && !deps.objectsLost) {
      const { store } = deps.media;
      const absent: { key: string }[] = [];
      for (const photo of photos) {
        // The smallest of the three stands for them: they are written together.
        const held = await store.get(objectKey(photo.content, "thumb")).catch((error: unknown) => {
          throw new DemoError(
            `the object store of this configuration does not answer (${error instanceof Error ? error.name : "unknown"}): is the stand-in running, and are S3_ENDPOINT and S3_BUCKET the API's? Nobody was erased`,
          );
        });
        if (held === null) absent.push(photo);
      }
      if (absent.length > 0) {
        throw new DemoError(
          `the object store of this configuration does not hold the photos of ${named(absent)}. Either it is not the store the API put them in (S3_ENDPOINT and S3_BUCKET are the API's), or the objects are lost, and then --objects-lost goes ahead without them. Nobody was erased`,
        );
      }
    }

    const { rows: accounts } = await tx.query<{ id: string; state: string }>(
      "SELECT id, state FROM account WHERE identity_id = ANY($1) AND state <> 'deleted'",
      [ids],
    );
    let erased = 0;
    let objects = 0;
    for (const account of accounts) {
      // Whatever its state: the erasure path takes a banned account as it is.
      const summary: ErasureSummary = await eraseAccount({ ...deps, db: tx }, account.id);
      erased += 1;
      objects += summary.objects;
      // What the erasure had to delete: the objects of the content no row
      // names any more (the media slice's own rule). It answers 0 when the
      // store failed, and throwing here takes the rows back with it.
      const mine = photos.filter((photo) => photo.account === account.id);
      const { rows: orphaned } = await tx.query(
        `SELECT 1 FROM unnest($1::text[]) AS k(key)
         WHERE NOT EXISTS (SELECT 1 FROM photo p WHERE p.key = k.key)`,
        [[...new Set(mine.map((photo) => photo.content))]],
      );
      const due = orphaned.length * PHOTO_VARIANTS.length;
      if (summary.objects !== due) {
        throw new DemoError(
          `the objects of the photos of ${named(mine)} were not deleted (${summary.objects} of ${due}): is the object store running? The reset is taken back: everybody's rows are as they were, and objects deleted before this one are gone (--objects-lost goes ahead without them)`,
        );
      }
    }
    // The ended ones only, by the sweep's own rule (deleteDeadAdminSessions).
    await tx.query(
      `DELETE FROM admin_session WHERE identity_id = ANY($1)
         AND (revoked_at IS NOT NULL OR expires_at < $2)`,
      [ids, at],
    );
    await deleteIdentities(tx, ids);
    return { identities: ids.length, erased, objects, spared };
  });
}
