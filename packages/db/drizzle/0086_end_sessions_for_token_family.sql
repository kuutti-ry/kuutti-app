-- Custom SQL migration file, put your code below! --
-- The refresh token's family secret of #490 (ADR-059 §7). A session row from
-- before it has no family_hash, which the next migration adds NOT NULL, and its
-- refresh token has the old shape, which the contract refuses. So every session
-- ends here, and every signed-in phone signs in through the bank once more.
-- Each push token goes with its session (0081's cascade, ADR-055 §3). The lock
-- holds to the end of the migrations' one transaction, through 0087, so a
-- sign-in on the container still running the old code cannot write a row
-- without a family in between; it waits, and fails once the column is there.
LOCK TABLE session IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DELETE FROM session;
