# Security Policy

## Reporting a vulnerability

Please do not report security problems through public issues, discussions, or pull requests.

Report them privately through GitHub's vulnerability reporting form:

https://github.com/kuutti-ry/kuutti-app/security/advisories/new

Include what you found, how to reproduce it, the affected commit or version, and any proof of concept. You will get an acknowledgement within 7 days and a status update once the issue has been assessed.

## Supported versions

Only the `main` branch receives security fixes.

## Disclosure

Please give us reasonable time to fix the issue before disclosing it publicly. We will credit reporters in the advisory unless they prefer to stay anonymous.

## Maintainer accounts

The GitHub organisation is part of what protects a release: a `v*` tag deploys production. Organisation owners therefore keep, for their GitHub account and for every account in `docs/runbooks/custody.md` they hold:

- two second factors, of which at least one is not the laptop they work on (a passkey on a phone, or a hardware security key);
- recovery codes stored off the device, in the project's password-manager entry or on paper in a place another owner knows of;
- no classic personal access token with access to the organisation, and fine-grained tokens only with the repositories and permissions the task needs.

An owner who loses a device tells the other owners the same day, revokes its sessions and tokens (GitHub, Expo, AWS Identity Center, the Google account, with `gcloud auth revoke` for a laptop's `gcloud` session), and registers a new second factor before doing anything else. On 2026-09-17 a maintainer's machine was wiped; what existed only there was lost. Nothing the project depends on may exist in one place only.
