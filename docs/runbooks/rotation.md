# Rotating keys and secrets

How each key, password and token the service uses is replaced, who may do it, how to check it worked, and what breaks while it happens (#199). One key is never replaced: the hetu HMAC key (section 6). Companion to `custody.md`, which says where each one lives and who holds it; no secret value is written here.

Every step here is the maintainer's, or an organisation owner's where it says so. An agent working in this repository runs none of them: signing in is the maintainer's (CLAUDE.md, Commands; `infra/README.md`, Tools).

There is no rotation calendar. Rotate when a value may have been seen by someone who should not have it, when a person who could read it leaves (below), and at the yearly custody review if the maintainer wants a rehearsal. `<env>` is `staging` or `prod`; production exists since 2026-10-24 (ADR-049), without bank identification and photos, so its Telia, HMAC and CloudFront lines are for later.

## Before any rotation

- Sign in: `pnpm aws:login`. For `gh`, an owner's login (environment secrets need admin rights on the repository).
- No merges to `main` while you rotate on staging. Every merge deploys staging (`build.yml` → `deploy.yml`) and so restarts the API with whatever SSM holds at that moment. Production deploys only from a `v*` tag.
- The API reads its parameters once, at boot (`loadConfig` in `apps/api/src/lib/config.ts`). A changed parameter does nothing until the API restarts.
- **Restart** means: redeploy the `api` application from Dokploy (`https://dokploy.staging.kuutti.app`, prod `https://dokploy.kuutti.app`; the admin login; `infra/README.md`, After the first apply). Re-running `main`'s latest `build.yml` run also redeploys staging (the `gh run rerun` command is in `infra/README.md`, Admin panel, step 4), but it rebuilds everything and publishes an update as well.
- **Check after a restart:**

  ```sh
  curl -fsS https://api.<env>.kuutti.app/health | jq '{status, db, migrations, commit}'   # prod: https://api.kuutti.app
  aws logs tail /kuutti/<env>/api --since 10m | grep -E 'bank identification|"media"|error reporting'
  ```

  `status` must be `ok` and `db` must be `ok`. The boot lines name the Telia key ids (`keys`) and the CloudFront key id (`keyPairId`); they are public values.
- Never print a secret in a Session Manager session: everything typed and shown there is streamed to `/kuutti/ssm-sessions` (`infra/README.md`, Checks).
- Update the password-manager entry named in `custody.md` in the same sitting.

## The list

| secret | where it lives | read by | who rotates | section |
|---|---|---|---|---|
| `/kuutti/<env>/db-app-password` | SSM SecureString | the API at boot; migrations | maintainer (AWS admin) | 1 |
| `/kuutti/staging/db-preview-password` | SSM SecureString | preview APIs at boot; the `kuutti-staging-preview-database` Run Command document | maintainer | 2 |
| RDS master password (`kuutti_admin`) | Secrets Manager, held by AWS | `db-app-role.sh`, `db-audit-owner.sh` when run | AWS | 3 |
| `/kuutti/<env>/telia-signing-key`, `/kuutti/<env>/telia-encryption-key` | SSM SecureString; the offline medium; staging also `~/kuutti-staging-keys` on the laptop | the API at boot | maintainer, as Telia's technical contact | 4 |
| Telia's own signing keys | Telia's JWKS | the API, from discovery | Telia | 5 |
| `/kuutti/<env>/hetu-hmac-key` | SSM SecureString; the offline medium; production also on paper in the sealed envelope | the API at boot | **nobody: never rotated** | 6 |
| `/kuutti/<env>/cloudfront-signing-key` | SSM SecureString; the offline medium; the public half in `infra/envs/<env>/` | the API at boot | maintainer | 7 |
| session and admin-session tokens, sign-in codes | hashes in the database | the API | nothing to rotate | 8 |
| `DOKPLOY_TOKEN` (two keys), the Dokploy admin login | GitHub environments; Dokploy | `deploy.yml`, `preview.yml`, `preview-cleanup.yml` | the Dokploy admin and a repository admin | 9 |
| `EXPO_TOKEN` | GitHub environments `staging`, `prod`, `preview`, `preview-cleanup` | `deploy.yml`, `eas-build.yml`, `preview.yml`, `preview-cleanup.yml` | an Expo owner or Admin and a repository admin | 10 |
| `SENTRY_AUTH_TOKEN`; the two DSNs | GitHub environments `staging`, `prod`; EAS environments `preview`, `production`; SSM `sentry-dsn` (String) | `deploy.yml`, EAS builds; the API and the app | the Sentry owner and a repository admin | 11 |
| GitHub variables, AWS access from CI | repository and environment variables; OIDC roles | the workflows | an owner | 12 |
| `FONTS_TOKEN`, read-only on `kuutti-ry/kuutti-app-fonts` alone | EAS environments `preview`, `production`, visibility secret. Never GitHub. The website's Amplify app holds a token of its own, rotated in `kuutti-app-site` (its decision 18) | EAS builds, `eas-build-pre-install` (`scripts/fonts.ts`, ADR-052) | the maintainer | 13 |

## 1. Database application password

`kuutti_app` is the API's own role; `infra/scripts/db-app-role.sh` created it and its parameter. The method is the one `infra/README.md` names under Secrets: `ALTER ROLE` through the tunnel, `put-parameter --overwrite`, restart.

**Who:** the maintainer, with the AWS session. It reads the master password the same way `db-app-role.sh` does.

**Steps.** Terminal one, the tunnel (the same port forward the script opens):

```sh
cd infra/envs/<env> && tofu init
aws ssm start-session --target "$(tofu output -raw instance_id)" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$(tofu output -raw db_host),portNumber=5432,localPortNumber=15432"
```

Terminal two, from the repository root. Note the time when you start; the timed run below wants it.

```sh
cd infra/envs/<env>
host=$(tofu output -raw db_host)
secret=$(tofu output -raw db_master_secret_arn)
cd -
new=$(openssl rand -hex 24)
master=$(aws secretsmanager get-secret-value --secret-id "$secret" --query SecretString --output text | jq -r .password)
conn="host=$host hostaddr=127.0.0.1 port=15432 dbname=kuutti user=kuutti_admin sslmode=verify-full sslrootcert=$PWD/apps/api/certs/rds-eu-central-1-bundle.pem"
# The SQL goes through stdin, as in db-app-role.sh, so the password is in neither psql's
# argument list nor its history. put-parameter does carry it as an argument, as the script's does.
# The && writes the parameter only if psql succeeded: a refused tunnel, a wrong path or a
# bad master password stops here and leaves the parameter as it was.
PGPASSWORD="$master" psql -v ON_ERROR_STOP=1 -q "$conn" <<SQL &&
ALTER ROLE kuutti_app PASSWORD '$new';
SQL
aws ssm put-parameter --name /kuutti/<env>/db-app-password --type SecureString --overwrite --value "$new" >/dev/null &&
echo "role and parameter changed"
unset new master
```

Restart only after `role and parameter changed` is printed, then at once, and close the tunnel. Without that line, do not restart: read the cases below.

**Check.** `/health` answers `"db":"ok"` after the restart. From the box, the check of `infra/README.md` (After the first apply, step 4) connects as `kuutti_app` with the parameter's value and prints `1`.

**What breaks meanwhile.** From the `ALTER ROLE` until the new process is up, the running API keeps the connections it has open but cannot open new ones. The pool sets no idle timeout (`packages/db/src/pool.ts`), so pg's default closes idle connections within seconds, and requests then fail with 5xx. `/health` turns `degraded`; after two minutes `kuutti-<env>-api-unreachable` fires and five 5xx in five minutes fire `kuutti-<env>-api-5xx` (`alerts.md`). Both clear after the restart. A process that boots between the two commands (a merge's deploy) fails its migrations and its `/health`. Previews are not affected: they connect as `kuutti_preview`. Anyone holding a tunnel `DATABASE_URL` with the old password (the moderator commands of `infra/README.md`, Photo moderation) reads the parameter again.

**If the `ALTER ROLE` succeeded and the `put-parameter` failed** (psql printed nothing, then an AWS error): the new value is lost with the `unset`. Run the block again from `new=` with a fresh value; nothing restarts in between.

**If psql failed:** the role and the parameter still hold the old password, and nothing is broken. Fix the cause (the tunnel, the path, the session) and run the block again.

**If the parameter changed but the role did not** (the lines were run one by one, say): put the previous version back before any restart, or the next boot fails its migrations. AWS CLI commands the repository does not use elsewhere; check `--help` first:

```sh
aws ssm get-parameter-history --name /kuutti/<env>/db-app-password --query 'Parameters[].[Version,LastModifiedDate]' --output text
old=$(aws ssm get-parameter --name "/kuutti/<env>/db-app-password:<previous version>" --with-decryption --query Parameter.Value --output text)
aws ssm put-parameter --name /kuutti/<env>/db-app-password --type SecureString --overwrite --value "$old" >/dev/null
unset old
```

The `--query` of the first line prints the version numbers and dates only, never a value.

## 2. Database preview password (staging)

`kuutti_preview` owns every `kuutti_pr_<n>` and cannot connect to `kuutti` (#9). Same steps as section 1 on staging, with `ALTER ROLE kuutti_preview` and `/kuutti/staging/db-preview-password`.

**Restart:** each open preview (`api-pr-<n>` in Dokploy's `previews` project) reads the password at boot; a new push to its pull request redeploys it, or redeploy it from Dokploy. The `kuutti-staging-preview-database` document reads the parameter on every run, so `preview-cleanup.yml` needs nothing.

**What breaks meanwhile:** open previews lose their database until they restart. Staging itself does not notice.

## 3. Database master password

`manage_master_user_password = true` (`infra/modules/data/main.tf`): AWS generates and holds it in Secrets Manager, and it never enters state. Nothing in the API uses it. `db-app-role.sh` and `db-audit-owner.sh` read it fresh each time they run, so a new value breaks nothing.

AWS rotates this secret on its own schedule. Neither the schedule nor an on-demand rotation is described in the repository: the maintainer checks it with `aws secretsmanager describe-secret --secret-id "$(tofu output -raw db_master_secret_arn)"` and, to rotate now, `aws secretsmanager rotate-secret` with the same id (AWS CLI commands the repository does not use elsewhere; check `--help` first).

## 4. Telia signing and encryption keys

Two RSA pairs per environment, `sig` and `enc` (`docs/vendors/telia.md`). The API signs request objects and client assertions with the first and decrypts the ID token with the second. It holds exactly one of each (`createTunnistusClient` of `@kuutti-ry/tunnistus-oidc`).

**Who:** the maintainer, who is Telia's technical contact (Appendix 4 of the agreement). Only the technical contact may exchange keys with Telia. For production keys Telia also asks the contact to sign the offered keys through its e-signature service with strong identification.

**Steps.**

1. Mount the offline medium. Generate the new pair into a **new directory** on it: `telia-keys.sh` refuses to overwrite a key, and its file names are fixed, so the old pair must stay where it is.

   ```sh
   mkdir /Volumes/<offline-medium>/telia-<yyyy-mm>
   KUUTTI_TELIA_CONTACT=<the association's mailbox> infra/scripts/telia-keys.sh <env> /Volumes/<offline-medium>/telia-<yyyy-mm>
   ```

   Do not use `--put`: it runs `put-parameter` without `--overwrite`, which fails on a parameter that exists. The script prints the two new kids.
2. Send `kuutti-<env>-telia-jwks.json` (public keys only) to Telia from the project mailbox, as the first registration was sent (`docs/vendors/telia.md`, The test-bed request). Agree with Telia on the moment it starts using the new keys. Whether Telia can hold the old and the new `enc` key at once, and which one it encrypts to while it does, is not in the repository: ask before the first production rotation.
3. At the agreed moment, put both private halves by file reference and restart:

   ```sh
   d=/Volumes/<offline-medium>/telia-<yyyy-mm>
   aws ssm put-parameter --name /kuutti/<env>/telia-signing-key --type SecureString --overwrite --value "file://$d/kuutti-<env>-telia-sig.pem"
   aws ssm put-parameter --name /kuutti/<env>/telia-encryption-key --type SecureString --overwrite --value "file://$d/kuutti-<env>-telia-enc.pem"
   ```

4. Ask Telia to remove the old keys. Then destroy the old private files on the medium; staging also replaces its laptop copy in `~/kuutti-staging-keys`. Write the new kids into `docs/vendors/telia.md` (Registered kids) in a pull request.

**Check.** The boot line `bank identification` lists `keys` with the two new kids, the same the script printed. Then one bank login end to end: on staging a Telia test person (`docs/vendors/telia.md`); on production a member of the team.

**What breaks meanwhile.** Logins only. If Telia encrypts to the new `enc` key while the API still holds the old one, or the other way round, every login fails at the token exchange (`no applicable decryption key selected`, `docs/vendors/telia.md`). If Telia no longer accepts the old `sig` key, the request object is refused. People already signed in are not affected: sessions do not touch Telia. A malformed key fails the boot on staging and production (`apps/api/src/boot.ts`): the API stays down. Put the old file back with `--overwrite` and restart. Previews have no bank login and do not notice.

## 5. Telia's own keys

Nothing to do. The API reads Telia's endpoints and keys from discovery and pins nothing; a token signed with a key it does not hold makes it fetch the JWKS again (`docs/vendors/telia.md`, The endpoints; security checklist, Telia broker keys). Telia announces its keys in advance in the metadata (Key Rotation note, guide 2.7.1).

## 6. The hetu HMAC key: never rotated

CLAUDE.md rule 2 and TD-1: the key is never rotated and never leaves SSM, except the one offline backup taken at creation (`infra/README.md`, Secrets).

**Why.** The hetu is never stored (rule 1). `HMAC-SHA256(hetu)` with this key is the identity's only key in the database: `identity.hetu_hmac`, and through it the staff roles (`moderator_roles`), the open bans and suspensions, the deletion count and the thirty-day cooldown (TD-7, ADR-007, ADR-024). A new key would give every person a different hash at their next login. Without the hetu there is no way to move the old hashes over. Every member would come back as a stranger: banned people clean, staff without their role, the cooldown gone. The key's loss is the same event, which is why the offline copy is the whole plan (`custody.md`).

**If it leaks.** Do not rotate. Treat it as an incident (`incident.md`, #191) and work out what leaked with it.

1. **What the key is worth.** Alone, nothing: it signs nobody in, and a login needs the bank. With the `hetu_hmac` column it is every member's identity code: the hetu has few possible values (a date of birth, a three-digit individual number and a check character), so whoever has both can try them all. The key is the lock that keeps the column from being a list of identity codes.
2. **Where it could have come from.** SSM (`/kuutti/<env>/hetu-hmac-key`, readable by that environment's instance role and by AWS admins), the offline medium, production's sealed envelope, and on staging the laptop copy. On staging every preview runs pull-request code with the staging instance role, which can read every `/kuutti/staging/*` parameter (`infra/README.md`, Previews, Trust). `parseConfig` drops the key from a preview's memory, which does not stop code that asks SSM itself.
3. **Close that path.** A box that may be compromised is rebuilt (`infra/README.md`, Backups and rebuilding the box). Every other secret its role could read is rotated by the sections above.
4. **Find out whether the database, a snapshot or a backup left too.** If it did not, the members' identity codes are still safe, and the database is now the only lock: keep it that way. If it did, the identity codes of every member are exposed. That is a personal data breach the association must handle; the notification duties are for the association's counsel (draft, not legal advice).
5. A new key scheme would change rule 2 and TD-1. That is the maintainer's decision and an ADR, not a step of this page.

**Staging** hashes Telia's test persons and the synthetic population only (`custody.md`: disposable). Replacing its key is still not a rotation: every staging identity would read as new at its next login. Whether to do that after a leak, and what then happens to the personas, is the maintainer's call and is not described here.

## 7. CloudFront signing key

The private half signs every photo URL. A profile photo's lives fifteen minutes (ADR-005 §3); a photo sent in a conversation's lives until the next five-minute mark and fifteen minutes more, so up to twenty minutes (ADR-031 §10). The key group trusts every public half committed as `infra/envs/<env>/cloudfront-signing-key.pub.pem` (the current one) or `cloudfront-signing-key.*.pub.pem` (more), each named by a hash of its PEM (`infra/modules/media/main.tf`). The apply writes the current key's id to `/kuutti/<env>/cloudfront-key-pair-id`. The API reads that id and the private half at boot and does not check that they match.

**Who:** the maintainer for the key and SSM. The pull requests go through review as usual. On staging each merge applies; on production each step needs a `v*` tag and the `prod` approval (`infra-prod.yml`).

**Steps.**

1. A new pair, offline, as at the cutover (`infra/README.md`, Media):

   ```sh
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /Volumes/<offline-medium>/kuutti-<env>-cloudfront-signing-<yyyy-mm>.pem
   openssl pkey -in /Volumes/<offline-medium>/kuutti-<env>-cloudfront-signing-<yyyy-mm>.pem -pubout -out infra/envs/<env>/cloudfront-signing-key.next.pub.pem
   ```

2. **Pull request one:** commit `cloudfront-signing-key.next.pub.pem`. The plan adds one public key; the group then trusts both. Nothing else changes.
3. **Pull request two, the switch:** rename the current file to `cloudfront-signing-key.previous.pub.pem` and `…next.pub.pem` to `cloudfront-signing-key.pub.pem`. The apply writes the new `cloudfront-key-pair-id`. As soon as that apply job ends:

   ```sh
   aws ssm put-parameter --name /kuutti/<env>/cloudfront-signing-key --type SecureString --overwrite \
     --value "file:///Volumes/<offline-medium>/kuutti-<env>-cloudfront-signing-<yyyy-mm>.pem"
   ```

   then restart.
4. **Pull request three**, at least twenty minutes later (the longest a URL lives, a sent photo's, ADR-031 §10): delete `cloudfront-signing-key.previous.pub.pem`. The apply removes the old public key. Destroy the old private file on the medium; staging also replaces its laptop copy.

**Check.** `aws ssm get-parameter --name /kuutti/<env>/cloudfront-key-pair-id --query Parameter.Value --output text` equals `keyPairId` in the API's `media` boot line. A photo opens in the app, and its URL carries `Key-Pair-Id=` with that id.

**What breaks meanwhile.** Photos only. Between the switch's apply and the restart that follows the `put-parameter`, a process that boots (for example the deploy of the same merge) holds the new id with the old private half, or the other way round. Every URL it signs answers 403 until the restart. Keep that gap short. A URL signed before the switch keeps working for the rest of its life, up to twenty minutes, because the old public key is still trusted until step 4.

**If the private half leaked:** anyone can sign URLs for objects under `/media/` and pass by the exposure budget (ADR-008). Run the steps at once and do not wait longer than the twenty minutes before step 4.

## 8. Session tokens and sign-in codes: nothing to rotate

There is no session secret. Access and refresh tokens, admin tokens and one-time sign-in codes are random 256-bit values; the database keeps only their SHA-256 hashes (`apps/api/src/identity/sessions.ts`, `admin-session.ts`, `codes.ts`). A refresh rotates both tokens with reuse detection. Admin sessions last eight hours.

To end every session at once (after a database leak, say), as `kuutti_app` through the tunnel of section 1:

```sql
UPDATE session SET revoked_at = now(), revoked_reason = 'logout_all' WHERE revoked_at IS NULL;
UPDATE admin_session SET revoked_at = now() WHERE revoked_at IS NULL;
```

`logout_all` is the reason the app's own "log out everywhere" writes. Every device fails its next request and goes back to the bank login; staff sign in again on the panel. This is not a command anywhere else in the repository: run it only as part of an incident.

## 9. Dokploy keys and the admin login

Two API keys, both `DOKPLOY_TOKEN`:

| key | Dokploy user | GitHub environments |
|---|---|---|
| the deploy key | the admin | `staging` (and `prod`) |
| the preview key | the member `ci-preview`, limited to the `previews` project | `preview`, `preview-cleanup` |

**Steps.** In Dokploy (`https://dokploy.staging.kuutti.app`, prod `https://dokploy.kuutti.app`), signed in as that user, Settings, Profile: generate a new API key. Then, as a repository admin (`gh secret set` prompts for the value; never paste it into a command line):

```sh
gh secret set DOKPLOY_TOKEN --env staging            # the admin's key
gh secret set DOKPLOY_TOKEN --env preview            # ci-preview's key
gh secret set DOKPLOY_TOKEN --env preview-cleanup    # the same ci-preview key
```

Then delete the old key on the same Dokploy page.

**Check.** The next deploy's step "Point the Dokploy application at the image and deploy" passes; the next pull request gets its preview; the next sweep of `preview-cleanup.yml` is green. For the preview key, repeat the check of `infra/README.md` (Previews, step 3): as the member, `application.one` on the staging application's id is refused.

**What breaks meanwhile:** if the old key is deleted before the new one is set, deploys and previews fail at that step. The sweep retries on its next run.

The Dokploy admin password and its two-factor authentication are changed in the same Settings, Profile page. Store them in `Kuutti / Dokploy <env>` (`custody.md`).

## 10. Expo robot token

`EXPO_TOKEN` is the authority to publish updates to every channel, `production` included, because updates are not code-signed (ADR-004). It exists in the environments `staging`, `prod`, `preview` and `preview-cleanup`, never at repository level (security checklist).

**Steps.** On expo.dev, as the organisation's owner or Admin, create a new access token for the robot user (Developer role; `apps/mobile/README.md`, Setting up EAS). Then:

```sh
for e in staging prod preview preview-cleanup; do gh secret set EXPO_TOKEN --env "$e"; done   # prompts four times
```

Then revoke the old token on expo.dev.

**Check.** `gh secret list --env <env>` shows the new date in all four. The next merge's deploy publishes its update to `staging`; the next pull request's web preview deploys.

**What breaks meanwhile:** the EAS steps of `deploy.yml` (after the API is already deployed), `eas-build.yml`, the preview lanes and the sweep's EAS removals fail until the new token is set. The sweep retries.

**If it leaked:** revoke first, before setting the new one. Then look at what was published to the `staging` and `production` channels since the leak (the project's updates on expo.dev). Roll a bad one back as ADR-004 says: republish the previous commit, or `eas update:republish`. Channel edits stay the maintainer's.

## 11. Sentry DSNs and the source-map token

**The DSNs** are public by design: they only let someone send events (`sentry-setup.md`). Replace one only when it is abused. In the Sentry project, Settings, Client Keys: create a new key. The API's: `aws ssm put-parameter --name /kuutti/<env>/sentry-dsn --type String --overwrite --value '<api DSN>'`, then restart; the boot line `error reporting` shows `"reporting":true`. The app's: replace `EXPO_PUBLIC_SENTRY_DSN` in the EAS environment (`preview`, and `production`), then publish an update or a build. The repository only creates EAS variables (`eas env:create`); to change one, use `eas env:update` (an EAS CLI command the repository does not use yet; check `--help`) or the project's page on expo.dev. Disable the old key in Sentry only when no installed build sends with it any more. To turn the API's reporting off at once: `aws ssm delete-parameter --name /kuutti/<env>/sentry-dsn`, then restart.

**The source-map token** (`SENTRY_AUTH_TOKEN`, the organisation token `ci-source-maps`, scopes `project:releases` and `org:read`) is a secret in exactly these places:

1. Sentry, Settings, Developer Settings, Organization Tokens: create a new token.
2. `gh secret set SENTRY_AUTH_TOKEN --env staging` (and `--env prod`).
3. The EAS environments `preview` and `production`, visibility secret: replace the value as for the DSN above.
4. Revoke the old token in Sentry.

**Check.** The next deploy's step "Upload the update's source maps to Sentry" passes, and the next EAS build uploads its maps (`devices.md`: a build without readable stack traces fails).

**What breaks meanwhile:** revoke the old token before the new one is in place and the upload step fails the deploy job (the update is already out), and EAS builds fail. Set first, revoke last.

Personal Sentry tokens made for settings work are revoked when the work is done (`sentry-setup.md`, section 1).

## 12. GitHub: secrets, variables, AWS access

- **Environment secrets** are the three above: `DOKPLOY_TOKEN`, `EXPO_TOKEN`, `SENTRY_AUTH_TOKEN`. `FONTS_TOKEN` is EAS's alone (13). The workflows read no other secret and none at repository or organisation level. Setting one needs admin rights on the repository (the organisation's owners).
- **Variables** are not secrets: role ARNs, the state bucket, URLs, ids and switches (`AWS_REGION`, `TF_STATE_BUCKET`, `AWS_PLAN_ROLE_ARN`, `AWS_APPLY_ROLE_ARN`, `AWS_PERMISSIONS_BOUNDARY_ARN`, `AWS_EXPORT_ROLE_ARN`, `ALERT_EMAIL`, `STAGING_ENABLED`, `PREVIEWS_ENABLED`, `EAS_ENABLED`, `EAS_PLATFORMS`, `EAS_BUILDS_ISSUE`, `DOKPLOY_URL`, `DOKPLOY_APPLICATION_ID`, `DOKPLOY_ENVIRONMENT_ID`, `API_URL`, `PREVIEW_API_DOMAIN`, `EAS_HOSTING_SUBDOMAIN`, `ADMIN_URL`, `ADMIN_BUCKET`, `ADMIN_DISTRIBUTION_ID`, `ADMIN_API_URL`). Nothing to rotate; a wrong one is set again with `gh variable set` from the commands in `infra/README.md`.
- **AWS access from CI** is OIDC only: the roles trust this repository's numeric ids and an environment or branch, and no AWS key exists anywhere in GitHub (`infra/README.md`, After bootstrap). Nothing to rotate. `GITHUB_TOKEN` lives for one run.
- **Owners' own tokens and second factors** follow `SECURITY.md`, Maintainer accounts.

## 13. The fonts token

`FONTS_TOKEN` lets a build read Saiga, Kuutti's typeface, from the association's private repository `kuutti-app-fonts` (ADR-052): a fine-grained token with Contents read on that repository alone, or a GitHub App's, the maintainer's choice. It lives in exactly these places, and in no GitHub secret, since no workflow ever has the typeface (`check-workflow-permissions.py` refuses one that names it):

1. GitHub, Settings, Developer settings, fine-grained tokens: a new one, resource owner `kuutti-ry`, repository `kuutti-app-fonts` only, Contents read-only; the organisation approves it.
2. The EAS environments `preview` and `production`, visibility secret: `eas env:create --name FONTS_TOKEN --environment preview --visibility secret` (and `production`), or `eas env:update` for a new value. A member's laptop needs none: `pnpm fonts` uses the member's own `gh` login.
3. Revoke the old token on GitHub. The website's token is another one, in its Amplify app; this does not touch it.

**Check.** The next EAS build's log shows `Saiga: …, verified` for each file in its install phase, and the build draws in Saiga.

**What breaks meanwhile:** nothing fails. A build without the token, or with a dead one, says so in its log and is drawn in the system font (`scripts/fonts.ts --soft`). Do not let one reach the store that way.

**If it leaked:** revoke it; the token reads the font files and nothing else. Whether Spoke is told is the maintainer's call (ADR-052).

## 14. Nothing to rotate

- **S3.** Deployed environments have no S3 keys: the API writes through its instance role. `S3_ACCESS_KEY` and `S3_SECRET_KEY` exist for the local stand-in only (`apps/api/src/lib/config.ts`).
- **The instance role's credentials** are short-lived and issued by AWS to the box. A box that may be compromised is rebuilt and every secret under its prefix is rotated (`incident.md`).
- **Encryption keys of SSM, S3 and RDS** are AWS-managed (`aws/ssm`, SSE-S3, RDS storage encryption). Their rotation is AWS's.
- **TLS certificates** renew themselves: ACM for CloudFront, Let's Encrypt through Traefik on the box.
- **Store signing credentials** (the Android keystore, the iOS distribution certificate and profiles) are held by EAS (`apps/mobile/README.md`, Setting up EAS). This page does not rotate them. A new Android keystore would change the fingerprint in `/kuutti/<env>/android-cert-fingerprints` (`devices.md`, Verified links).
- **Developer keys** for maintainer tools are not service secrets: the Claude API key of `pnpm i18n:translate` (`packages/i18n/README.md`) and the image-model key of the demo pictures (`docs/demo/photo-prompts.md`) live in the developer's own environment and are revoked at their provider.
- **Human logins** (the mailbox, AWS root and Identity Center, GitHub, Expo, Dokploy, Sentry) are `custody.md`'s; a lost device is `SECURITY.md`'s.

## When someone with write access leaves

Write access is staging-level trust: a pull request's preview runs its code on the staging box with the staging instance role and the `preview` environment's tokens (`infra/README.md`, Previews, Trust; ADR-004 §3). When a person with write leaves the team, after their access is removed:

- `EXPO_TOKEN` in all four environments (section 10);
- `FONTS_TOKEN` in the EAS environments `preview` and `production` (section 13): anyone with write access could start a build that holds it;
- the `ci-preview` Dokploy key (section 9);
- on staging, what the role could read: `db-app-password` (1), `db-preview-password` (2), the Telia keys (4), the CloudFront key (7). The staging HMAC key is section 6's staging paragraph.

An organisation owner who leaves also had admin rights: add the deploy key (9) and the Sentry token (11).

## Timed runs

#199 asks for one rotation run by this page and timed: the database application password on staging (section 1). Fill a row each time.

| date | env | section | who | from `ALTER ROLE` to `/health` ok | total | notes |
|---|---|---|---|---|---|---|
| not run yet | staging | 1 | maintainer | | | |

## Open

- How Telia handles two registered `enc` keys at once, and how a switch moment is agreed (section 4). Ask id-maintenance before the first production rotation.
- The schedule of AWS's own rotation of the RDS master secret (section 3).
- Whether staging's HMAC key is ever replaced after a leak, and what then happens to the personas (section 6).
