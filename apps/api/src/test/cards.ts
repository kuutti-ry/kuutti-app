import type { Queryable } from "@kuutti/db";

/**
 * "The viewer was shown the subject's card" (#84), as `recordCardServed`
 * leaves it: the viewer's card_shown row on an approved photo of the
 * subject's, the subject's first one or a new one. Plain SQL like
 * `signedInAccount`: a test of another slice may not import the card's
 * internals, and serving a card is the profile slice's tests' business.
 * Returns the photo's id.
 */
export async function cardShown(
  db: Queryable,
  viewerAccountId: string,
  subjectAccountId: string,
  at: Date = new Date(),
): Promise<string> {
  const { rows } = await db.query<{ photo_id: string }>(
    `WITH existing AS (SELECT id FROM photo
                       WHERE account_id = $1 AND purpose = 'profile' AND state = 'approved'
                       ORDER BY position LIMIT 1),
          made AS (INSERT INTO photo (account_id, key, blurhash, width, height, state, position)
                   SELECT $1, md5($1::text), 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 800, 1067, 'approved',
                          (SELECT coalesce(max(position) + 1, 0) FROM photo
                           WHERE account_id = $1 AND purpose = 'profile')
                   WHERE NOT EXISTS (SELECT 1 FROM existing)
                   RETURNING id),
          chosen AS (SELECT id FROM existing UNION ALL SELECT id FROM made)
     INSERT INTO card_shown (account_id, photo_id, at) SELECT $2, id, $3 FROM chosen
     ON CONFLICT (account_id, photo_id) DO UPDATE SET at = EXCLUDED.at
     RETURNING photo_id`,
    [subjectAccountId, viewerAccountId, at],
  );
  const photoId = rows[0]?.photo_id;
  if (!photoId) throw new Error("card_shown not written");
  return photoId;
}
