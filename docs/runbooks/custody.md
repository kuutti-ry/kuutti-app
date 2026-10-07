# Custody of the project's identities

Who holds which credential, how it is protected, and how it is recovered when the holder or their device is gone. Companion to `aws-account-setup.md`; no secret values live here, only where they are and who can reach them. The 2026-09-17 disk wipe is why this exists: everything that was on one machine only was lost with it.

Fill the *holder*, *MFA*, *backup factor* and *second custodian* columns from the real accounts; rows marked *unverified* have not been checked since the wipe. Review at every handover and at least once a year (next: **2027-08**, before the domain renews on 2027-09-17 and the card on file may have expired).

## Identities

| identity | used for | holder today | MFA | backup factor | password-manager entry | second custodian | recovery path |
|---|---|---|---|---|---|---|---|
| Project mailbox (`MAILBOX`, Gmail) | root email for AWS, Expo owner login, domain registrant contact | maintainer | hardware key or passkey (runbook 0.4) | backup codes in the entry | `Kuutti / mailbox` | none yet | Google account recovery → recovery phone and email (runbook 0.3, currently the maintainer's) |
| AWS root (`kuutti`, 438298963814) | account ownership, billing, closing the account | maintainer | *unverified*: one virtual device `phone` seen 2026-09-18; runbook 2.3 wants two hardware keys | second MFA device `root-backup` (*unverified*) | `Kuutti / AWS root` | none yet | root sign-in with MFA; lost MFA → AWS phone/email recovery, ends in the mailbox above |
| AWS Identity Center user `maintainer` | day-to-day admin (`pnpm aws:login`) | maintainer | MFA required by the identity store | none | `Kuutti / AWS Identity Center` | none yet | root creates a new user; nothing under `infra/` depends on this user |
| GitHub organisation `kuutti-ry` | code, CI, secrets, environments | three owners (`superseacat`, `juusohe`, `OlliKiljunen`) | 2FA required org-wide | each owner's own recovery codes | personal | the other two owners | any owner; billing email is still a personal Gmail (org Settings → Billing → move it to `MAILBOX`) |
| Expo organisation `kuutti` | native builds, credentials, and the whole update path: updates are not code-signed (ADR-004), so this account and its robot token decide what installed builds run | owner `kuutti.expo` (the mailbox identity); `superseacat` Admin | *unverified* on both | recovery codes (*unverified*) | `Kuutti / Expo owner` | none yet | owner login through the mailbox; an Admin cannot delete the org or change the owner |
| Domain `kuutti.app` (Route 53 Domains) | DNS, certificates, App/Universal Links later | the AWS account | (AWS) | auto-renew and transfer lock on | – | – | moves with the account; registrant verification must read `DONE` (`aws route53domains get-contact-reachability-status`) |
| Telia Identification Service Agreement and technical contact (Appendix 4) | the bank-login broker (docs/vendors/telia.md) | not signed yet: offer of 2026-10-07 answered (test bed now, S package in production), the agreement expected for review on 19.10.2026; the test bed runs without it; the maintainer is the intended technical contact | – | – | `Kuutti / Telia Tunnistus` (offer, agreement, contact, `client_id`) | the association's chair | Telia re-registers the contact on the association's written request |
| Telia signing and encryption keys (`/kuutti/<env>/telia-signing-key`, `-encryption-key`) | request objects, client assertions and ID-token decryption in the Telia exchange | do not exist yet; `infra/scripts/telia-keys.sh` generates them onto the offline medium and loads SSM from there | – | the offline medium is the copy (infra/README, Secrets) | – | – | rotatable: generate new keys, send the public JWKs to Telia, switch the SSM values (`--overwrite`), restart; the old keys stay valid until Telia drops them |
| hetu HMAC key (rule 2) | identity derivation, M2 | does not exist yet | – | one offline copy at creation (infra/README, Secrets) | – | – | never rotated; loss is unrecoverable by design, so the offline copy is the whole plan |
| CloudFront signing key (`/kuutti/<env>/cloudfront-signing-key`, ADR-005) | signed photo URLs; the public half is `infra/envs/<env>/cloudfront-signing-key.pub.pem` in the repository | does not exist yet (created at the media cutover, infra/README, Media) | – | one offline copy at creation | `Kuutti / CloudFront signing <env>` | – | rotatable without downtime: a second public key in the key group, the new private half into SSM, restart, remove the old key; a lost private half only means signing a new pair |
| Dokploy admin (staging, prod) | deploy control plane, M1 #7 | not created yet | 2FA in Dokploy (infra/README step 3) | – | `Kuutti / Dokploy <env>` | – | rebuild the box from code; Dokploy config restored from the `/etc/dokploy` backup |

## Rules

- Every row has a password-manager entry under the project, never under a personal vault, so the association inherits it (TD-4). Recovery codes and backup keys go in the same entry or in the sealed envelope, never on the laptop alone.
- No identity may be recoverable through exactly one device. The mailbox is the root of every recovery chain above, so it gets the strongest protection and the first second custodian.
- Second custodian: another organisation owner receives, in person, either a registered backup security key or the sealed recovery codes for the mailbox and AWS root. Until that happens the project has a bus factor of one, and this file says so.
- Write access to the repository is staging-level trust, and with unsigned updates the trust of a push to `main` (ADR-004). Today only the three organisation owners have it. Before granting it to anyone else, switch on the required reviewer of the `preview` environment (`infra/README.md`, Previews, Trust): it was removed on 2026-09-19 because it stopped nobody.
- Handover to the association (TD-4): re-point the root email and registrant contact to the association's alias, move the Identity Center instance (ADR-001, step 7 of `infra/README.md`), transfer the Expo owner login and the password-manager vault. Nothing under `infra/` changes.

## Checklist

- [ ] Mailbox: second factor registered, backup codes in the entry, recovery phone/email noted
- [ ] AWS root: two MFA devices, no virtual device, zero access keys (`aws iam get-account-summary`: MFA 1, keys 0)
- [ ] Expo owner and the maintainer's Admin login: 2FA on, recovery codes in the entry (they guard the unsigned update path, ADR-004)
- [ ] GitHub org billing email moved to the project mailbox
- [ ] Second custodian named above and holding a backup factor
- [ ] Reminder set for 2027-08: domain renewal, card validity, this review
