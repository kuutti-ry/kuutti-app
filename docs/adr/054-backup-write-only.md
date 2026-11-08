# ADR-054: The box writes its Dokploy backup and never reads it back

- Status: proposed (built as written here at the maintainer's word of 2026-10-25, "fix it"; the apply of each environment switches it on; accepting it is the maintainer's)
- Date: 2026-10-25
- Follows: ADR-001 (Dokploy's configuration is the one manual island, backed up nightly from `/etc/dokploy`), ADR-004 §3 (write access to the repository is a preview's trust, and staging-level trust), ADR-048 (a restore brings the owner back before Dokploy serves), ADR-053 (the previews' wildcard key sits in `acme.json`), TD-19 (one staging box with the previews on it); issues #7, #448

## Context

The nightly job puts `/etc/dokploy` and a dump of Dokploy's database under `dokploy-backup/<env>/` of the state bucket, and the instance role could read and list that prefix so that a rebuilt box could fetch its backup. On staging a preview runs a pull request's code under that role, so it could read every backup: Traefik's `acme.json`, with every certificate key on the box and the ACME account key, and Dokploy's database. Staging-level trust covered staging's parameters, not the control plane's keys.

## Decision

1. **The instance role writes and never reads.** `modules/compute` keeps `s3:PutObject` under the prefix with SSE-KMS and drops `s3:GetObject` and `s3:ListBucket` there, in both environments.
2. **A rebuild fetches through the maintainer's session.** He presigns the object for five minutes, and S3 decrypts it for the link's signer (`infra/README.md`, Backups and rebuilding the box, step 2). Checked on 2026-10-25: a presigned GET of a staging backup answered 206.

## Consequences

- A preview no longer reads any certificate key on the box, and ADR-053's "Gained" no longer includes the wildcard's key.
- Production's role loses the same read, which only its rebuild used.

## Not done, and what would make it needed

- **A signature from a key only the host holds**, checked before a restore. The role still writes under the prefix, as the nightly job needs, and previews hold it; a signature would tell the job's objects from any other. It needs a key made at first boot, a document for the running boxes and the public half recorded per box. Worth it before the first release.
- **A customer-managed KMS key whose decrypt only the maintainer holds.** It would keep the backups from the apply role too, which reads the bucket but runs reviewed code from `main`; about 1 USD a month per key. Needed if the apply role ever runs unreviewed code.

## Alternatives considered

- **Saying so in the README and accepting it**, since staging holds invented people only (ADR-018): it would leave every certificate key on the box to any pull request.
- **Restoring through a Run Command document sent by the plan role:** every pull request assumes that role, and it is denied `kms:Decrypt`.
