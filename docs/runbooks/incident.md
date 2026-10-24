# Incidents: who notices, who decides, what is done

What to do when Kuutti breaks or leaks (#191): how an incident is noticed, how bad it is, who does what in an association with one maintainer, what the code can do to stop it, whom to tell, and the review afterwards. The staging outage of 2026-09-27 is the worked example. The last section is the restore drill, written and not yet run.

Companions: `alerts.md` (each alarm and its first three commands), `custody.md` (who holds which account and key), `rotation.md` (each key's rotation), `police-disclosure.md` (a lawful request from the police is not an incident), `SECURITY.md` (how outsiders report a vulnerability). `<env>` is `staging` or `prod`, `<id>` the box's instance id (`tofu output -raw instance_id` in `infra/envs/<env>`). Every AWS and box command needs the maintainer's session (`pnpm aws:login`); an agent never runs them.

Staging holds no real person (ADR-018 §1), and production has nobody until the first release (#25). Until then an incident is an outage or an exposed key, never a personal data breach. The sections on people and the Data Protection Ombudsman are written for the day production has people.

## Severity

| level | what it is | examples | how fast |
|---|---|---|---|
| S1 | Personal data of real people exposed or likely exposed; somebody else holds a key, a token or an account of ours; something we did not publish reaches installed apps | a copy of the production database outside AWS; the hetu HMAC key out of SSM; `EXPO_TOKEN` exposed, from any environment, since it can publish to `production` (ADR-004); a GitHub owner account taken over (a `v*` tag deploys production); the AWS account in other hands | Start at once, whatever else waits. The GDPR clock may be running (below). Call the second person and tell the chair. |
| S2 | Production down or broken for people, no data at risk; staging down when a demo is due | `kuutti-prod-api-unreachable`; sign-in failing for everybody; a bad update on the `production` channel that breaks the app | The same day. |
| S3 | Staging or a preview broken, nobody's data at risk | `kuutti-staging-api-unreachable` with no demo due; a preview that will not boot; one `api-5xx` burst; a budget mail | The next working session. |

When unsure between two levels, take the higher one and lower it later in the record.

## Roles

| role | who today | does |
|---|---|---|
| Lead | the maintainer | The only person with AWS, Dokploy and the Expo owner login (`custody.md`). Decides the containment, runs the commands, keeps the record. |
| Second person | another owner of the GitHub organisation (`custody.md` lists the three) | Keeps the timeline while the lead works, reads every outgoing text, and can act on GitHub alone: set the switch variables below, remove a member's write access. Cannot reach AWS: until a second custodian exists, the bus factor is one (`custody.md`). |
| The association's board, through its chair | the chair | The association is the controller. The board decides whether the Ombudsman and people are notified, and approves every public text. |
| Moderators and admins | staff holding a role in the panel | Apply a sanction from a person's page; a ban is an admin's (ADR-024 §3). |
| Counsel | the association's counsel (the maintainer fills in the name) | Assesses a personal data breach and the texts that go out. |

If the maintainer cannot be reached, nobody can take the API down or rotate a key held in AWS. The second person sets `STAGING_ENABLED`, `PREVIEWS_ENABLED` and, for the update path, `EAS_ENABLED` to `false`, asks an admin to ban the account involved, and keeps trying the maintainer. `EAS_ENABLED` does not stop a leaked `EXPO_TOKEN`; only its revocation on expo.dev does (The update path, below). Production deploys wait for the maintainer's approval anyway.

## Where incidents come from

- **Alarm mails** to the address in the repository variable `ALERT_EMAIL`: every alarm of `infra/modules/observability`. `alerts.md` gives each one's meaning and first commands, except `kuutti-<env>-photo-budget-refusals`, which it has no row for yet; its commands are under Scraping and floods, below. That alarm (100 refusals in a day) points at a scraper, or at a budget set too low (ADR-008). Billing mails go to the billing alias.
- **Sentry**: the default "new issue" mail for the projects `api` and `mobile` (`sentry-setup.md`).
- **People**: feedback from the app, read in the panel under `/feedback` (ADR-023); reports and blocks come with #84.
- **Security reports** through the private form in `SECURITY.md`.
- **Vendors**: AWS service and abuse notices go to `MAILBOX+security` and `MAILBOX+ops` (`aws-account-setup.md` step 3); Telia announces disruptions at `https://tunnistus.telia.fi/uas/resource/maintenance.txt` (`docs/vendors/telia.md`); GitHub secret scanning and the `secret-scan.yml` and `audit.yml` workflows.
- **The logs**: `aws logs tail /kuutti/<env>/api`, the saved queries `kuutti-<env>/errors-by-route` and `kuutti-<env>/boot-and-fatal`, and the `sign-in refused` warn lines of the sign-in doors (ADR-026). The group keeps 30 days.

## The first ten minutes

1. Write down the time in UTC and what told you. That moment matters later: for a personal data breach it starts the 72 hours.
2. Open the record. It has up to two parts, kept apart:
   - **The incident record**: the timeline, every step and its time, account ids and request ids, and for a personal data breach the entry of Art. 33(5) (below). Like the disclosure record (`police-disclosure.md`, section 8), it is a document in a place only the maintainer, the second person, the chair and counsel can open. It belongs to the association, not to a personal account (TD-4), and it is never in this repository or anywhere on GitHub: user data does not go into an external service (CLAUDE.md, Security and privacy defaults). Where it is: *the maintainer fills in, with the board*.
   - **The vulnerability**, if there is one: a draft security advisory through the form in `SECURITY.md`, which only the repository's admins see. It says what is broken and how it is fixed, never an account id, a log line or a key value: an advisory is published once the fix is out (`SECURITY.md`, Disclosure).

   For an outage with no personal data and no secret in it, an ordinary issue is the whole record. Account ids, key names and log lines never go into an issue.
3. If an alarm started it, run its row in `alerts.md` (the photo-budget alarm: Scraping and floods, below), then `curl -sS https://api.<env>.kuutti.app/health` (prod: `https://api.kuutti.app/health`).
4. Pick the severity. For S1, call the second person now and tell the chair.
5. Ask: could personal data of real people be involved? Production only. If yes, the clock runs from step 1; see "The Data Protection Ombudsman".
6. Keep the evidence before changing anything. Take a database snapshot before a repair touches the database (Evidence, below); never delete a log group or a session log.
7. Do the smallest containment that stops the harm (next section). Write every step and its time into the record as you go.

## Containment: what the code can do

### One person

From the person's page in the panel (`/accounts/<id>`, reached by account id only; `https://admin.staging.kuutti.app` on staging, `https://admin.kuutti.app` in production from #25): Sanctions. A suspension or a ban ends every app session of the identity's accounts and every panel session of the identity in the same transaction, and their photos stop being served to anybody at once; URLs already signed still work for up to fifteen minutes (ADR-024 §4 and §6). A suspension ends at the start of a day you pick, at most 366 days ahead; the night job `end-suspensions` lifts it. A ban, its lift and its review are an admin's; a review is by somebody other than who applied it. A member of staff cannot be sanctioned in the panel: the maintainer revokes the role first (Sessions, below).

### Sessions

- **One person, at their request**: "Log out everywhere" on the device screen of Settings (`POST /auth/logout-all`).
- **One person, by staff**: a suspension does it (above). There is no staff action that only signs somebody out, and a suspension shows in the person's export (ADR-024 §8).
- **A member of staff**: `pnpm --filter @kuutti/db moderator -- revoke <hetu_hmac>` through the database tunnel ends their panel sessions at once (`infra/README.md`, Photo moderation; `list` shows who holds a role; production needs `--env production`).
- **Everybody**: the two statements of `rotation.md`, section 8, as `kuutti_app` through the database tunnel, with the reason the app's own "log out everywhere" writes (`logout_all`). The tokens are kept only as SHA-256 hashes, so a copy of the `session` table opens no session; ending them all is for a flaw in the session code or a write to the database. The guards refuse a revoked session on its next request (`apps/api/src/lib/auth-middleware.ts`, `admin-middleware.ts`), and every person signs in through the bank again. For one account only, add `AND account_id = '<id>'` to the first statement.

### Scraping and floods

- **The photo-budget alarm** (`kuutti-<env>-photo-budget-refusals`; `alerts.md` has no row for it yet). First: `aws logs tail /kuutti/<env>/api --since 24h --filter-pattern '{ $.msg = "photo refused" && $.reason = "budget" }'`. Each line names the `accountId`, the `variant`, `used` and `limit` (`apps/api/src/media/photos.ts`). One account with many lines is a script: suspend it (One person, above). Many accounts each just over the limit means the budget is too low: raise it, as in the next item.
- Lower or raise `photo_fetches_per_day` in the panel under `/config` (an admin; a new version with a reason, written to the audit log first). It takes effect without a restart.
- The request limits are parameters read at boot: `/kuutti/<env>/rate-limit-per-minute` and `/kuutti/<env>/sign-in-rate-limit-per-minute` (ADR-026 §5). Set them with `aws ssm put-parameter --type String --overwrite`, then redeploy the API.

### Taking the API down, and bringing it back

The API runs as a Swarm service under Dokploy (`alerts.md`, the `api-unreachable` row):

```sh
aws ssm start-session --target <id>
sudo docker service ls                          # the api service is <env>-api-<suffix>
sudo docker service scale <env>-api-<suffix>=0  # down; the app, the panel and the nightly jobs stop with it
sudo docker service scale <env>-api-<suffix>=1  # back
```

Or stop and start the `api` application in Dokploy. A deploy brings it back, so close the path first: on staging `gh variable set STAGING_ENABLED --body false` (a merge then deploys and applies nothing; set it back to `true` afterwards); in production nothing deploys without the `prod` reviewer's approval of a `v*` tag, so withhold it. Back up: `/health` answers `"status":"ok"`, and the probe mails OK about four minutes later.

A preview that eats the box (as on 2026-10-08): `sudo docker service scale api-pr-<n>-<suffix>=0`. `gh variable set PREVIEWS_ENABLED --body false` stops new previews, and the cleanup sweep as well, so turn it back on soon.

### The update path

A JavaScript update reaches installed apps without a store review, and updates are not code-signed (ADR-004). If a bad or foreign update is on a channel, first ask whether `EXPO_TOKEN` may be out: an update nobody merged, a run nobody started, a token seen somewhere. Every copy of the token can publish to any channel and re-point any channel (ADR-004 §2). `EAS_ENABLED` gates only `deploy.yml` and `eas-build.yml`; the copies in `preview` and `preview-cleanup`, and any copy outside GitHub, still work.

If the token may be out (`rotation.md`, section 10):

1. An Expo owner or Admin revokes the robot user's token on expo.dev. Nothing comes before this.
2. Put the last good update back: `eas update:republish` of its update group, or publish the previous commit again (ADR-004). Check everything published to `staging` and `production` since the token may have left (the project's updates on expo.dev).
3. A new token into the four environments, as `rotation.md` section 10 says.

If the token is not the cause (a bad merge):

1. Put the last good update back, as above.
2. `gh variable set EAS_ENABLED --body false` stops `deploy.yml` from publishing updates and `eas-build.yml` from building until the fix is merged. Set it back to `true` afterwards.

A native binary is stopped in the stores, not here (Apple and Google, below).

### Keys and tokens

Every rotation is in `rotation.md`. What an exposure means:

| key or token | if it is out |
|---|---|
| `/kuutti/<env>/hetu-hmac-key` | It is never rotated (rule 2; `rotation.md`, section 6, says why and what to do). Alone it reveals nothing. With a copy of `identity.hetu_hmac` it gives back identity codes: there are few enough possible codes to try them all, and fewer still with the `account` table's `birth_year` and `birth_month`. Key and database together are S1 for every person, and nothing contains what is already out. |
| `/kuutti/<env>/telia-signing-key`, `-encryption-key` | The signing key lets somebody act as our client towards Telia; the encryption key opens ID tokens, which carry the identity code (rule 1). Rotate (`rotation.md`, section 4), and tell Telia (below). |
| `/kuutti/<env>/cloudfront-signing-key` | Anyone holding it can sign photo URLs. Rotate: a second public key, the switch, the removal (`rotation.md`, section 7). |
| `/kuutti/<env>/db-app-password` | The database admits port 5432 from the box's security group only (`infra/modules/network`), so the password alone opens nothing from outside. Rotate (`rotation.md`, section 1). |
| `EXPO_TOKEN` | S1 from any environment: it can publish to `production` (ADR-004). Revoke it first: The update path, above, and `rotation.md`, section 10. |
| `DOKPLOY_TOKEN` | The `staging` and `prod` copies deploy the API; the `ci-preview` member's reaches only the `previews` project. Rotate (`rotation.md`, section 9). |
| `SENTRY_AUTH_TOKEN` | Uploads source maps (`project:releases`, `org:read`). Rotate (`rotation.md`, section 11). |
| `FONTS_TOKEN` | Reads `kuutti-app-fonts` alone: Saiga's files, which are licensed to Kuutti only. Revoke it (`rotation.md`, section 13); whether Spoke is told is the maintainer's call (ADR-052). |
| a font file pushed to `kuutti-app` | Public at once, and still reachable after a squash (`refs/pull/<n>/head`). Ask GitHub Support to purge it; whether Spoke is told is the maintainer's call (ADR-052 §7). |
| the box, or its instance role `kuutti-api-<env>` | The role reads every `/kuutti/<env>/*` parameter, the secret ones included; on staging, every preview runs pull-request code with the same role (`infra/README.md`, Previews, Trust). First the maintainer takes a snapshot of the box's root volume: the rebuild destroys it (`delete_on_termination` in `infra/modules/compute`), and with it the containers' files, Docker's volumes and `/var/log/dokploy-backup.log`. No command for that is in the repository (`aws ec2 create-snapshot` of the instance's root volume; check `--help` first); the snapshot holds secrets, so delete it when the review is done. Then rebuild as `infra/README.md`, Backups and rebuilding the box, says, with the alert address set as in the restore drill below (part 2, step 2). Then rotate every secret under the prefix: `rotation.md` sections 1, 2 (staging), 4 and 7. The HMAC key is the first row of this table. |
| an owner's GitHub or Expo login, the AWS session | `SECURITY.md`, Maintainer accounts: tell the other owners the same day, revoke sessions and tokens, new second factor first. Recovery paths are in `custody.md`. |

### Error reports with personal data

If a Sentry event shows anything on the list in `sentry-setup.md` ("What Sentry must never receive"):

1. Stop the sending. In the Sentry project that sent it (`api` or `mobile`; both if unsure), Settings, Client Keys: disable the key. This needs no release and no restart. It is the only quick stop for `mobile`: the app's DSN is `EXPO_PUBLIC_SENTRY_DSN`, built into every build and update (`infra/README.md`, Observability). For `api`, also `aws ssm delete-parameter --name /kuutti/<env>/sentry-dsn` and restart, which turns the SDK off (`rotation.md`, section 11).
2. Delete the events in Sentry, and find the leak.
3. After the fix is out, a new client key, as in `rotation.md`, section 11.

### Evidence

- Database: `aws rds create-db-snapshot --db-instance-identifier kuutti-<env> --db-snapshot-identifier kuutti-<env>-incident-<yyyymmdd>`. A manual snapshot is kept until deleted, outside the 35 days: delete it when the review is done, since it holds people's data.
- Logs: `/kuutti/<env>/api` keeps 30 days. Save the query results the review needs into the incident record (never the advisory or an issue): account ids and request ids, nothing more.
- The box: every Session Manager session is in `/kuutti/ssm-sessions`. A rebuild destroys the root volume, and with it the containers' files, Docker's volumes and the box's own logs; only CloudWatch, the Dokploy backup and the database outlive it. For a box that may be compromised, snapshot the root volume before the rebuild (Keys and tokens, the box's row).

## Telling people

### Inside the team

The second person and the chair for S1, by phone or in person. For S2 and S3, the record is enough. An issue is public: it carries no account id, key name or log line.

### People who use Kuutti

Draft, for the association's counsel. Today Kuutti cannot reach people one by one: there are no push notifications (#102) and nothing sends mail (#196); the optional e-mail address (TD-18) is stored, but no code sends to it. What exists:

- a notice on `kuutti.app`, through the site's repository `kuutti-ry/kuutti-app-site` (a push to its `main` deploys, `infra/README.md`, The website);
- once the app is listed (#193), the store listing's text, by the maintainer.

A text that goes out is written in Finnish first, the binding language (TD-17), then Swedish and English by a person, never by machine (`.claude/rules/i18n.md` treats legal texts that way). It says what happened, what it means for the reader, what Kuutti has done and what the reader can do. The contact it names is the one the privacy policy names (#190), never a postal address. The board approves it.

### The Data Protection Ombudsman

**Draft for the association's counsel. This is not legal advice and nobody has reviewed it.**

GDPR articles 33 and 34, as this page reads them:

- **Every breach is recorded** in the incident record, notified or not: what happened, its effects, what was done (Art. 33(5)).
- **The Office of the Data Protection Ombudsman** (Tietosuojavaltuutetun toimisto) is notified without undue delay and within 72 hours of becoming aware, unless the breach is unlikely to result in a risk to people. A later notice gives the reasons for the delay. It may come in parts. It says: what happened, which kinds of data and about how many people and records; a contact point; the likely consequences; what was done or is planned. The board decides; the maintainer prepares it. The office's own notification form and the controller's details are the board's; neither is in this repository.
- **People** are told without undue delay when the risk to them is high, in plain words. When contacting each person is impossible, a public notice is the fallback (above).
- **Processors** (AWS, Sentry, Expo) tell us of their breaches through the account mailboxes. Their notice starts our own assessment.

For a dating service, most breaches of profile data are high risk. What the database, the logs and the backups hold, table by table and for how long, is the inventory in `police-disclosure.md`, section 4. For a breach, read it with these notes:

- Whom a person seeks (`preferences`) and their politics and religion answers (`profile`) are special categories of data (art. 9), held on explicit consent (ADR-019 §4). The consents themselves are in `consent`.
- `identity.hetu_hmac` means nothing alone. With the HMAC key it gives the identity code back (Keys and tokens, above): key and database together are the worst case.
- `photo_access` and `card_shown` say who was shown whose photos. For a dating service that is sensitive in itself.
- The database backups keep erased rows for 35 days (`infra/modules/data`), so a leaked snapshot can hold people who had already left.
- The logs and Sentry carry account ids and request ids; never hetu, e-mail, message text or `seeks` (CLAUDE.md).

A crime against Kuutti (an intrusion, extortion) is reported to the police; the board decides, with counsel.

### Telia

When the incident touches the bank login (the Telia keys, logins nobody made, the callback): tell Telia at id-maintenance@teliacompany.com; faults are answered around the clock at 0200 20 300 (`docs/vendors/telia.md`). In production, only the technical contact of the agreement's Appendix 4 exchanges keys, and new keys are confirmed through Telia's e-signature service. The agreement is not signed yet (`custody.md`); when it is, the maintainer adds here what it says about incidents. When Telia itself is down, check its maintenance file (above), and tell people on the site.

### Apple and Google

Steps for the maintainer. None of these names is in the repository yet.

- **Apple**: the app is under the maintainer's individual Apple developer account (`apps/mobile/README.md`). A released binary that must stop reaching people is removed from sale in App Store Connect; a TestFlight build is expired there. Apple is told through App Store Connect when it must know, for example when the developer account itself is affected.
- **Google**: the Play Console account does not exist yet (M6). Once it does: halt the rollout of a bad release there. Add the account to `custody.md` when it is created.
- A bad JavaScript update is stopped at EAS (The update path), not in the stores.

## After: the review

Within a week of the all-clear, in the incident's record, without blame: the question is what let it happen, not who. A change to a decision goes into its ADR (`docs/adr/README.md` says how). Each action is an issue of its own. When the incident has an issue, the action carries `Refs #<incident issue>`. When its record is the association's document or an advisory, the action issue says what is to be done in words that name no account and no unfixed vulnerability, and the record lists the issue. A runbook row that was wrong or missing is fixed in the same week.

```markdown
## Summary
Two sentences for a person: what broke, for whom, for how long.

## Severity and scope
S1/S2/S3 · environment · personal data involved: yes/no
(if yes: the Ombudsman notified when, people told when and how, or why not)

## Timeline (UTC)
- first signal:
- noticed (and by what):
- contained:
- resolved:
- all-clear:

## Cause
The chain of events, not a person.

## What worked

## What did not

## Actions
- [ ] #n: what, whose

## Evidence kept, and when it is deleted
```

## Worked example: the staging outage of 2026-09-27

**Summary.** The staging API was unreachable for about an hour. The server ran out of memory because three previews of merged pull requests were still running on it.

**Severity and scope.** S3 under this page: staging, nobody's data (ADR-018). It would have been S2 had a demo been due.

**Timeline (UTC).** Alarm mails `kuutti-staging-api-unreachable` at 11:59 and 12:47, `kuutti-staging-api-5xx` at 12:46 (#77). The previews were removed by hand (ADR-012).

**Cause.** The staging box is a t4g.small with 1.8 GB and no swap. It carried the staging API, Dokploy (0.8 to 1 GB on its own) and the previews of #64, #66 and #69, all merged. Their removal ran under the `preview` environment and waited for a reviewer's click that did not come. The kernel's OOM killer took Dokploy every two minutes; each kill broke the Swarm agent's heartbeat, and the manager restarted every service (ADR-012, Context).

**What worked.** The probe alarm (#29) mailed; it is the one alarm that sees a dead container (`alerts.md`).

**What did not.** Nothing measured memory. The cleanup depended on a person.

**Actions.** ADR-012, the same day: previews are removed unattended, by a sweep from `main` that every merge starts (#76). #77 (ADR-046): swap in the box's first-boot script, a memory alarm, and the `api-unreachable` row's memory commands; a memory limit on Dokploy was tried and withdrawn (ADR-046 §2).

**It came back on 2026-10-08**, 17:39 to about 18:20 Helsinki time (#77). Two merges two minutes apart and a preview deploy hit the box at once; six API containers ran; a reboot alone brought the loop back. Fixed by hand through one SSM Run Command: `docker service scale api-pr-152-ccsysx=0` (a merged pull request's preview the sweep could not reach) and a 2 GB `/swapfile`. EC2's status check saw a healthy instance the whole time. The live box had its swap by hand from then; since #77 (ADR-046) a rebuilt box has it from first boot, and a running one from the headroom document.

## The restore drill

**Not yet done** (2026-10-17). Neither an RDS restore nor a restore of the Dokploy backup into a fresh box has ever run (#7, #191). This is the procedure for the maintainer, on staging, which holds no real person. Time each step; write the result in the record table at the end and fix the steps here and in `infra/README.md` where they were wrong. The drill instance is a resource outside code, deleted the same day: #7 called such an instance a decision, not a click, and #191 asks for this one.

### Part 1: the database, to a point in time

The data module keeps 35 days of point-in-time recovery, a daily automated snapshot in the window 23:30 to 00:00 UTC, and, in production only, a final snapshot `kuutti-prod-final` when the instance is destroyed (`infra/modules/data`). A restore always makes a new instance; the old one is not touched.

1. `pnpm aws:login`. Note the start time.
2. Read what the new instance needs from the old one:

   ```sh
   aws rds describe-db-instances --db-instance-identifier kuutti-staging \
     --query 'DBInstances[0].[LatestRestorableTime,DBSubnetGroup.DBSubnetGroupName,VpcSecurityGroups[0].VpcSecurityGroupId,DBParameterGroups[0].DBParameterGroupName]' --output text
   ```

   The subnet group is `kuutti-staging` and the security group `kuutti-staging-db`, the only one the box may reach. Pass the managed parameter group (`kuutti-staging-postgres17-*`, which sets `rds.force_ssl`) so the drill runs with the same parameters as the code; without it the restore gets AWS's default group.
3. Restore. Pick a restore time a few hours back and write it down:

   ```sh
   aws rds restore-db-instance-to-point-in-time \
     --source-db-instance-identifier kuutti-staging \
     --target-db-instance-identifier kuutti-staging-drill \
     --restore-time <YYYY-MM-DDTHH:MM:SSZ> \
     --db-subnet-group-name kuutti-staging \
     --vpc-security-group-ids <db security group id> \
     --db-parameter-group-name <parameter group name> \
     --no-publicly-accessible --no-multi-az \
     --tags Key=Project,Value=kuutti Key=Purpose,Value=restore-drill
   aws rds wait db-instance-available --db-instance-identifier kuutti-staging-drill
   ```

   Note the time it became available. From a snapshot instead: `aws rds describe-db-snapshots --db-instance-identifier kuutti-staging --snapshot-type automated --query 'sort_by(DBSnapshots,&SnapshotCreateTime)[-1].DBSnapshotIdentifier' --output text`, then `aws rds restore-db-instance-from-db-snapshot --db-instance-identifier kuutti-staging-drill --db-snapshot-identifier <id>` with the same network, parameter group and tag options.
4. Verify from the box, as `kuutti_app`, whose password the restored instance shares with SSM unless it was rotated after the restore time:

   ```sh
   aws rds describe-db-instances --db-instance-identifier kuutti-staging-drill --query 'DBInstances[0].Endpoint.Address' --output text
   aws ssm start-session --target "$(cd infra/envs/staging && tofu output -raw instance_id)"   # after tofu init there
   # on the box, once with the drill's address and once with the live one (/kuutti/staging/db-host):
   PGPASSWORD="$(aws ssm get-parameter --name /kuutti/staging/db-app-password --with-decryption --query Parameter.Value --output text)" \
     psql "host=<address> dbname=kuutti user=kuutti_app sslmode=verify-full sslrootcert=/etc/kuutti/rds-ca.pem" \
     -c "select (select count(*) from identity) identities, (select count(*) from account) accounts, (select max(registered_at) from account) last_registration, (select max(at) from audit_log) last_audit, (select ssl from pg_stat_ssl where pid = pg_backend_pid()) tls"
   ```

   On the drill, `last_registration` and `last_audit` are before the restore time, and the counts are at most the live ones. `tls` is `t`. Note the time.
5. Delete the drill instance and check it is gone:

   ```sh
   aws rds delete-db-instance --db-instance-identifier kuutti-staging-drill --skip-final-snapshot --delete-automated-backups
   aws rds wait db-instance-deleted --db-instance-identifier kuutti-staging-drill
   ```

### Part 2: the box, from the Dokploy backup

The four steps of `infra/README.md`, "Backups and rebuilding the box", on staging. Staging is down while they run: tell the team first, and pick a time with no demo.

1. Check a backup exists: `aws s3 ls s3://kuutti-tfstate-438298963814/dokploy-backup/staging/`. Note the newest object.
2. Give the local apply the same input as CI. CI hands the repository variable `ALERT_EMAIL` to OpenTofu as `TF_VAR_alert_email` (`.github/workflows/infra.yml`). Without it, `alert_email` is null and the apply destroys the e-mail subscriptions of both alert topics (`infra/modules/observability`): the alarms still fire, to nobody. A `-replace` plans the whole environment, not the one resource. From the repository root:

   ```sh
   export TF_VAR_alert_email="$(gh variable get ALERT_EMAIL)"
   cd infra/envs/staging && tofu init
   tofu plan -replace=module.compute.aws_instance.api
   ```

   Read the plan. It replaces the instance and changes what refers to it, and it destroys no `aws_sns_topic_subscription`. If it shows anything else, stop.
3. In the same shell, run the four steps as written. Step 1 is a local `tofu apply -replace=module.compute.aws_instance.api`, while the README's Environments section otherwise keeps applies to CI, and the README's rebuild steps do not name the variable of step 2: write both down as gaps, and fix the README after the drill.
4. The new box has its swap and the free-memory metric from first boot (#77, ADR-046). Once `cloud-init status --wait` reports done, `free -m` shows 2 GB of swap, and `kuutti-staging-memory-low` returns to OK within minutes; until then it says ALARM, since no data counts as breaching.
5. Check: `curl -sS https://api.staging.kuutti.app/health` answers `"status":"ok"`; Dokploy's UI signs in at `https://dokploy.staging.kuutti.app` with its two-factor login; re-run `main`'s latest `build.yml` run and see `deploy.yml` deploy; a pull request's preview deploys; `/etc/cron.d/dokploy-backup` exists and the next night's object appears; the probe and the status-check alarm return to OK. The alarm state says nothing about delivery, so also check both subscriptions, still in `infra/envs/staging`:

   ```sh
   aws sns list-subscriptions-by-topic --topic-arn "$(tofu output -raw alerts_topic_arn)"
   aws sns list-subscriptions-by-topic --region us-east-1 \
     --topic-arn arn:aws:sns:us-east-1:438298963814:kuutti-staging-alerts-us-east-1
   ```

   Each shows one e-mail subscription with an ARN, not `PendingConfirmation`. Then run the delivery test of `alerts.md`.

### Bringing a restored database into service

Not exercised, and not part of the drill until the maintainer adds it. What the code says a real recovery has to handle:

- **The API must not write to the old instance meanwhile.** Take it down first (above).
- **The address.** The API finds the database through `/kuutti/<env>/db-host`, which `infra/envs/<env>` writes from the data module's instance `kuutti-<env>`. A restored instance has another name. Either the restored instance takes the name `kuutti-<env>` (the old one renamed or deleted first; in production it has deletion protection), or the parameter changes. Either way OpenTofu's state still points at the old instance and must be moved to the new one before the next apply, or the apply undoes the switch. That is the maintainer's, with his session.
- **Migrations.** The API applies the committed migrations at boot (rule 10), so a restore point older than the last migration is migrated forward on the first boot.
- **What happened after the restore point is gone**: registrations, sanctions, consents, erasures. Put these right before people return:
  - Erasures. `aws logs tail /kuutti/<env>/api --since 30d --filter-pattern '{ $.msg = "account erased" }'` lists the accounts erased in the last 30 days. The restore brings them back, and the person asked for them to be gone. No command erases an account by id outside the person's own route, and the logs keep 30 days while recovery reaches back 35.
  - Withdrawn consents. `{ $.msg = "consent withdrawn" }` lists them the same way, with the kind. A research consent that comes back with the restore brings back its `research_subject` row, the mapping to a `research_id`, and events would be written for a person who said no (ADR-010 for the consent, ADR-011 §1 for the mapping); a special-category consent took `seeks` and the special-category answers with it, and the restore brings them back.
  - Sessions. Sessions ended after the restore point (logouts, sanctions) answer again: end every session (Sessions, above) before the API is back up.
  - Sanctions applied after the restore point are gone as well. If the old instance still answers, its `audit_log` lists them (`sanction.apply`, `sanction.lift`, ADR-024 §9); staff apply them again in the panel.
- **Photos.** The media bucket keeps no versions, so a photo deleted after the restore point is gone while its row comes back, and a photo uploaded after it has no row.

### Record

| date | who | what | restore point | minutes to available | minutes to verified | gaps found | fixed in |
|---|---|---|---|---|---|---|---|
| not yet run | | | | | | | |
