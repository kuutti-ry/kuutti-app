# Ending the service

How Kuutti would be shut down, if the association ever decides to: the notice, the export window, the stop, the deletion of every copy, the vendors, the domain and what the association keeps (#199). It is written ahead so that an ending is orderly and complete, not because one is planned.

The decision and the dates are the association's. This page covers what the repository defines. What the repository does not define is marked as such, and the legal parts are a **draft for the association's counsel, not legal advice**. Every technical step is the maintainer's, with his own AWS session; an agent runs none of them.

`<account>` is the AWS account id. Production exists from #25; staging holds invented people only (ADR-018), so its part is a teardown, not a deletion of anyone's data.

## The three dates

| date | what happens |
|---|---|
| **T0, the notice** | Members are told. The service keeps running, so everyone can still download their data. |
| **T1, the stop** | The API stops. From here nobody can sign in or download anything. |
| **T2, all deleted** | Every copy of member data is gone, except what section 1, step 4 keeps (exported in 4.2). |

Nothing in the repository fixes these lengths. The issue names "the 90-day deletion"; this page reads it as **T2 no later than 90 days after T1**, and the maintainer confirms. Ninety days is what several clocks in the system already run to: the research events (ADR-011), the refresh token (`apps/api/src/identity/sessions.ts`), the Dokploy backups (`infra/bootstrap/main.tf`) and the Session Manager log (`infra/modules/compute/main.tf`).

## What holds data

Production, unless the row says otherwise.

| where | what | member data | kept today | goes in |
|---|---|---|---|---|
| RDS `kuutti-prod`, database `kuutti` | accounts, identities (`hetu_hmac`), profiles, consents, sessions, feedback, sanctions, the audit log, research events | yes | until deleted; the audit log five years, photo-check notes twelve months, events 90 days (`.claude/rules/db.md`, ADR-011) | 4.5 |
| RDS automated backups | the same, as point-in-time copies | yes | 35 days (`infra/modules/data/main.tf`) | 4.5 |
| RDS snapshots: `kuutti-prod-final`, and a manual one before each release-tag migration (`.claude/rules/infra.md`) | the same | yes | until deleted by hand | 4.5 |
| S3 `kuutti-media-prod-<account>` | photos, three variants each; versioning off | yes | until deleted | 4.4 |
| SSM `/kuutti/prod/*`; the offline medium; the sealed envelope | keys and passwords (`rotation.md`, The list) | no, but the HMAC key unlocks `hetu_hmac` | until deleted | 4.1, 4.6 |
| Log group `/kuutti/prod/api` | request lines with `account_id` and request id, never hetu, message text, e-mail or `seeks` | pseudonymous | 30 days | 4.7 |
| Log group `/kuutti/ssm-sessions` | what was typed and shown in Session Manager | possibly | 90 days | 4.7 |
| Sentry `kuutti-ry`, projects `api` and `mobile` | errors; request data, user and IP stripped (`sentry-setup.md`) | not by design | Sentry's own retention (not in the repository) | 4.7 |
| Research copies outside the database | the Parquet export (#194, not built today) and what the research partner holds | pseudonymous or anonymous (ADR-011 §9) | the research agreement's (not in the repository) | 4.3 |
| S3 `kuutti-admin-<env>-<account>` | the moderation panel's files | no | until deleted | 4.8 |
| State bucket `kuutti-tfstate-<account>` | OpenTofu state, `dokploy-backup/` (90 days), `github-export/` (365 days) | no | as shown | 4.12 |
| Telia | the identification events of every bank login | yes, Telia's | five years in a sealed environment, Traficom's rule for every broker (`docs/vendors/telia.md`) | Telia's obligation, not ours |
| The project mailbox (`custody.md`) | what members, authorities and processors wrote to the association, and its answers (`incident.md`, `police-disclosure.md`) | yes | not defined | section 1, step 4; then 4.13 |
| The disclosure record and the incident record, kept by the association outside the repository | each request from an authority and its answer; each incident and breach (`police-disclosure.md`, The record; `incident.md`) | yes | disclosure record: five years, a proposal for counsel; incident record: not defined | section 1, step 4; then 4.13 |
| Members' phones | the session in the secure store; any export they downloaded | their own | until they uninstall | the notice tells them |
| Staging, its previews and their databases | Telia's test persons and the synthetic population | no real person (ADR-018) | until torn down | 4.8 |

## 1. Before the notice

1. **The decision.** The association decides to end the service and sets T0, T1 and T2. Counsel reads this page's draft parts (Obligations, below) and the notice text.
2. **The agreements.** Read the notice periods of the Telia Identification Service Agreement and of the research agreement. Neither is in the repository.
3. **Build what is missing.** Three things the ending needs do not exist today. Each is an issue of its own, opened at the decision:
   - **A notice in the app.** No screen shows a message from the association. A text goes through `packages/i18n/messages.yaml` (the Finnish text is binding, TD-17) and reaches installed phones with an EAS Update on the `production` channel, if it is JavaScript only.
   - **A way to close sign-up.** Nothing stops new registrations while the service runs. Without one, people can still join between T0 and T1.
   - **E-mail.** There is no mail channel: the optional e-mail exists on the account (#148, TD-18), the sending is #196. If #196 has landed by then, a notice by mail to those who gave an address is possible.
4. **What is kept.** Decide it now: the notice says it, and 4.1 makes it final. The default is what TD-7 keeps after an erasure: the audit log, each row for five years from when it was written (`.claude/rules/db.md`, `apps/api/src/safety/audit.ts`), and report snapshots for twelve months once they exist (M4). Keeping less or more is the association's decision on counsel's advice, written as an ADR, since it changes data retention (CLAUDE.md, Decisions). The same decision covers the association's own records of the table above: the mailbox, the disclosure record and the incident record. Anything kept for its link to an identity, such as an open ban (ADR-024) or an identity row, loses that link at 4.1: without the key, `hetu_hmac` matches nobody. Keeping the link would mean keeping the key, which changes 4.1 and needs the same ADR.

## 2. The notice (T0)

**What it says:**

- the stop date (T1) and the deletion date (T2);
- how to keep a copy: "Download my data" in the app, before T1 (ADR-007: one zip with the photos);
- what is deleted and by when, and what the association keeps and for how long (section 1, step 4);
- that research events end with the database, and what happens to the research partner's copies (4.3);
- that the bank-login provider keeps its own records of each login under its own obligations (`docs/vendors/telia.md`);
- how to reach the association: its mailbox.

**Where it goes:**

| channel | how | in the repository |
|---|---|---|
| the website `kuutti.app` | a page in the site's own repository, `kuutti-ry/kuutti-app-site` | the site is served by Amplify from that repository (`infra/README.md`, The website) |
| the app | the notice of section 1, by EAS Update | needs building |
| e-mail | only with #196 | needs building |
| the store listings | the listing text says the service ends; the app stays on sale until T1 (section 3) | no: the store release is M5 |
| the research partner, Telia, the moderators | the association writes to them | no |

Moderation keeps running until T1: photos are still uploaded and checked.

## 3. The stop (T1)

1. **Stop the API.** In Dokploy (`https://dokploy.kuutti.app`), stop the `api` application, or from the box scale its service to 0 as `alerts.md` does. `kuutti-prod-api-unreachable` fires: expected. Phones now get no answer; nothing they hold can sign anyone in without the bank (`apps/mobile/README.md`).
2. **Close the update path.** No more `v*` tags: a tag redeploys the production API (`build.yml`, the job `deploy prod`), applies production's infrastructure (`infra-prod.yml`) and starts a production build (`eas-build.yml`). Revoke `EXPO_TOKEN` on expo.dev (`rotation.md`, section 10) so that nothing can publish to installed phones again.
3. **The stores.** Remove the app from sale in the App Store and on Google Play, in each store's console. This is a recommendation, not a step the repository defines; nothing is listed today. Why not at T0: the app is the only way to download one's data (no web surface, CLAUDE.md rule 8), and a member who changes phone between T0 and T1 needs the store to install it again. Delisting at T0 would stop people installing an app that is about to stop, at that cost. The maintainer and the association choose.
4. **The point of no return.** Once the stop is final, nobody plans to start the service again, and what is kept is decided (section 1, step 4), go on with section 4.1. After it, the service can never come back with its members.

## 4. Deletion (T1 to T2), in this order

### 4.1 The hetu HMAC key first

Delete `/kuutti/prod/hetu-hmac-key` (`aws ssm delete-parameter --name /kuutti/prod/hetu-hmac-key`; that removes every version), wipe the copy on the offline medium, and shred the sealed envelope. Two people witness the envelope and the medium; the sunset record (section 5) says when and who.

Why first: once the API is stopped, no process needs the key. With the key gone, no copy of the database that might still exist (a snapshot, a backup, a dump someone made) can be turned back into identity codes: the `hetu_hmac` column becomes meaningless (`rotation.md`, section 6). It is also final. A service started again later could not recognise anyone it knew; the key's loss is unrecoverable by design (`custody.md`).

Staging's key (SSM, and the copy in `~/kuutti-staging-keys` on the laptop) goes with 4.6.

### 4.2 What is kept

What section 1, step 4 decided, and nothing more. Unless an ADR says otherwise, that is the audit log, and the report snapshots if they exist by then. Export it before 4.5 onto the encrypted offline medium, write its end date into the sunset record (for the audit log, five years after its newest row), and delete it on that date. How to export a table is not described in the repository; the maintainer does it through the tunnel of `rotation.md`, section 1.

### 4.3 Research

The events table goes with the database. Its rows are pseudonymous while a person's mapping row exists and anonymous once it is gone (ADR-011 §9). The Parquet export (#194) does not exist today; if it does by then, its files go before the bucket that holds them. The research partner deletes its copies as the research agreement says, and confirms it in writing. The research consent promised events "for up to 90 days" (`legal.research.summary`, a draft).

### 4.4 Photos

Empty the media bucket `kuutti-media-prod-<account>`. Versioning is off, so a deleted object is gone (`infra/README.md`, Media). The command (`aws s3 rm s3://kuutti-media-prod-<account>/ --recursive`) is not used elsewhere in the repository: check it on staging's bucket first. Then `aws s3 ls s3://kuutti-media-prod-<account>/` lists nothing.

### 4.5 The database and its copies

1. Production's instance is protected: `db_deletion_protection` defaults to `true` (`infra/envs/prod/variables.tf`). While it is on, AWS refuses to delete the instance, and the module would take a final snapshot `kuutti-prod-final` (`infra/modules/data/main.tf`). Lift it with a local apply, right before the destroy of 4.8 and under the same ADR:

   ```sh
   cd infra/envs/prod && tofu init
   tofu apply -target=module.data -var db_deletion_protection=false
   ```

   The plan must show one change, in place, to `module.data.aws_db_instance.this`: `deletion_protection` and `skip_final_snapshot` flip, and `final_snapshot_identifier` goes. Not through a `v*` tag: section 3, step 2 ended those, and a tag would also redeploy the stopped API and start a production build. `infra/README.md` keeps applies to CI (Environments); this one is local for that reason, and the ADR says so.
2. Delete the instance with the teardown (4.8).
3. After 4.8, make sure no copy is left. AWS's own commands, not used elsewhere in the repository:

   ```sh
   aws rds describe-db-snapshots --db-instance-identifier kuutti-prod
   aws rds describe-db-instance-automated-backups --db-instance-identifier kuutti-prod
   ```

   Delete every snapshot and retained backup they list (`aws rds delete-db-snapshot`, `aws rds delete-db-instance-automated-backup`). Both lists must come back empty.

### 4.6 Keys and passwords

Delete every secret parameter under `/kuutti/prod/` and `/kuutti/staging/` with `aws ssm delete-parameter`: the Telia keys, the CloudFront key, `db-app-password`, `db-preview-password`, and the staging HMAC key. Delete the parameters made by hand the same way; they are not resources and outlive the teardown:

- `/kuutti/<env>/sentry-dsn` (`infra/README.md`, Observability);
- `/kuutti/staging/sentry-self-test`, if it is still set (`sentry-setup.md`);
- `/kuutti/<env>/android-cert-fingerprints` and `/kuutti/<env>/ios-team-id`, if they were set (`devices.md`, Verified links);
- `/kuutti/ci-check/secret` (`infra/README.md`, Secrets).

The rest are resources (`aws_ssm_parameter.config` in `infra/envs/<env>/main.tf`: `app-env`, the `db-` names, the media and `oidc-` values and the others) and go with the teardown. After 4.8, this lists nothing (an AWS command the repository does not use; the API reads its prefix the same way, `apps/api/src/lib/ssm.ts`):

```sh
aws ssm get-parameters-by-path --path /kuutti/ --recursive --query 'Parameters[].Name'
```

Destroy the private halves on the offline medium and on the laptop (`custody.md`). Ask Telia to remove the registered keys and the client.

### 4.7 Logs and error reports

`/kuutti/prod/api` keeps 30 days and `/kuutti/ssm-sessions` 90 days; let them run out, or delete the groups with the teardown. In Sentry, delete the projects `api` and `mobile`, then the organisation `kuutti-ry` (its owner, the project mailbox's account).

### 4.8 The infrastructure

The maintainer runs `tofu destroy` in `infra/envs/prod`, after the apply of 4.5, then in `infra/envs/staging`, with his own session. This is a local destroy, not the CI path, and it changes the infrastructure, so it carries an ADR (CLAUDE.md, Decisions). What stands in the way today:

- `prevent_destroy` on the API security group (`infra/modules/network/main.tf`), and in the bootstrap on the hosted zone and the state bucket. Removing those lines is part of that change.
- Buckets with objects in them; none has `force_destroy`. Empty them first, as in 4.4: production's media bucket (4.4); before the staging destroy, staging's media bucket `kuutti-media-staging-<account>` (synthetic photos; staging's `media_enabled` defaults to `true`, `infra/envs/staging/variables.tf`); and the panel's bucket `kuutti-admin-staging-<account>` (production's, once #25 adds one). The panel's bucket keeps no versions either (`infra/modules/admin/main.tf`).
- The previews: `preview-cleanup.yml` removes them, or they go with the staging box and instance.

Dokploy and its configuration go with the box.

### 4.9 Vendors

- **Expo:** revoke the robot token (done at T1), then delete the project and the organisation `kuutti` with the owner login (`custody.md`).
- **GitHub Container Registry:** the images `ghcr.io/kuutti-ry/kuutti-api` hold code only; they may stay with the repository.
- **Telia:** end the agreement on its terms (not in the repository). The technical contact asks Telia to remove the client and its keys. Telia keeps its own identification logs for five years; that is its obligation.
- **Apple and Google:** the app records are removed or left delisted (section 3, step 3). Not in the repository.

### 4.10 The repository

Archive it on GitHub. The source stays public under the AGPL and holds no member data. Before that, delete the environment secrets and the environments (`staging`, `prod`, `preview`, `preview-cleanup`). The weekly export stops with its role; its copies go with the state bucket (4.12).

### 4.11 The website and the domain

The site keeps a closing page for as long as the association wants to be reachable there. Keep `kuutti.app` registered for a while after T2: as long as the association holds it, nobody else can put up a service under the name on that domain (`TRADEMARKS.md`), and the domain-wide records that stop it being used for spoofed mail (SPF, DMARC, null MX, `infra/bootstrap/dns.tf`) stay in place. How long is the association's call; the domain renews on 2027-09-17 (`custody.md`). When it goes: retire the Amplify app (`delete-app`, then the records it left, `infra/README.md`, The website), turn auto-renew off, and delete the hosted zone last.

### 4.12 The AWS account

Last, because the state bucket and the domain live in it. The bootstrap keeps its own state in the bucket it created (`kuutti-tfstate-<account>`, key `bootstrap/terraform.tfstate`, `infra/bootstrap/versions.tf`), and that bucket is versioned and keeps old versions for 365 days (`infra/bootstrap/main.tf`). So `tofu destroy` cannot run there as it stands. In `infra/bootstrap`:

1. Move the state off the bucket, the reverse of how it got there (the comment in `versions.tf`): comment out the `backend "s3"` block, then `tofu init -migrate-state`. The state is now `terraform.tfstate` in that directory (gitignored, `infra/.gitignore`). It holds what the bucket held, so it stays on the maintainer's machine only until step 3.
2. Empty the state bucket of every object version and every delete marker: the environments' state, `dokploy-backup/` and `github-export/`. The S3 console's Empty does it; from the CLI, `aws s3api list-object-versions` and `aws s3api delete-objects` (AWS commands the repository does not use; check `--help` first). `aws s3 rm --recursive` is not enough on a versioned bucket.
3. `tofu destroy`, with the `prevent_destroy` lines removed (4.8). It also removes the hosted zone and its records, so it waits until the domain goes (4.11). Then delete the local state file.

Then close the account as root: root is kept for billing, MFA changes and closing the account (`aws-account-setup.md`, section 5). AWS keeps a closed account for a period before it deletes what is left; that period is AWS's and not in the repository.

### 4.13 The identities

The project mailbox stays until the last vendor account above is closed: every recovery chain ends in it (`custody.md`). Before it goes, what members and authorities wrote there is deleted or kept, as section 1, step 4 decided; the disclosure record and the incident record likewise. After that the association decides. Password-manager entries lose their secrets but keep their history, as part of the record.

## 5. The sunset record

What the association keeps, with no member data in it:

- the decision, T0, T1 and T2;
- the notice as sent, in each language and channel;
- each step of section 4: the date, who did it, and the read-back that shows it gone (an empty listing, a refused `get-parameter`);
- the destruction of the HMAC key and the other private keys, with the witnesses;
- the vendors' confirmations: the research partner, Telia, Sentry, Expo;
- anything kept under 4.2, with its end date, and the date it was deleted.

## Obligations of the association (draft for counsel)

**A draft for the association's counsel; not legal advice.** The questions the repository cannot answer:

- **Notice.** How long before the stop members must be told, and through which channels. The terms of use (`legal.terms.summary`, a draft) say nothing about the service ending.
- **What must be kept.** Whether the default of section 1, step 4 (the audit log five years under TD-7, report snapshots twelve months) is right after the stop, whether anything else must be kept and how long: the open bans, the mailbox's correspondence, the disclosure record (five years proposed) and the incident record, and requests from the police (`police-disclosure.md`, #189) that may arrive after T1. Telia keeps its own logs for five years.
- **Research.** What the research partner must delete and confirm, given the consent's "up to 90 days".
- **Processors.** Ending the agreements with AWS, Sentry, Expo and Telia, and the deletion confirmation from each.
- **Records.** Whether the end of the processing must be written into the association's record of processing activities. The association's own records (minutes, accounts) are outside this repository.
- **The name.** Whether the association keeps the name Kuutti and the domain after the end (`TRADEMARKS.md`).

## Not in the repository

- The lengths of T0 to T1 and T1 to T2; the issue's "90-day deletion" read as above.
- An in-app notice, a sign-up switch, and the mail channel (section 1).
- The notice periods of the Telia agreement and the research agreement.
- The store consoles' steps.
- The AWS, Sentry and Expo deletion details: the RDS snapshot commands, the bucket emptying commands (the versioned state bucket's included), the parameter read-back, the account's post-closure period, Sentry's retention.
- Where the disclosure record and the incident record live, and how long the incident record and the mailbox's correspondence are kept.
