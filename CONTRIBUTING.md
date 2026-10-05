# Contributing to Kuutti

Thanks for helping. Kuutti is a free, open-source dating app for Finland, run as a non-profit. This page covers the legal and mechanical side of contributing; product and technical decisions live in the project docs and, later, in `docs/adr`.

## Licence

The code is licensed under the GNU Affero General Public License v3.0 (see `LICENSE`) with an additional permission that lets the app be distributed through the Apple App Store and Google Play (see `LICENSE-EXCEPTION`). By contributing, you agree that your contribution is licensed under those same terms, including the additional permission.

We use the Developer Certificate of Origin instead of a contributor licence agreement. You keep your copyright. There is nothing to sign and nothing to send.

## Developer Certificate of Origin (required)

Every commit must carry a `Signed-off-by` line certifying the [Developer Certificate of Origin](DCO). The line states that you wrote the change, or have the right to submit it, under the project licence. Read the `DCO` file once; it is short.

Add the line with the `-s` flag when you commit:

```bash
git commit -s -m "Describe the change"
```

That appends a trailer using your git name and email:

```
Signed-off-by: Your Name <you@example.com>
```

Use your real name. A GitHub noreply address is fine if you keep your email private.

A DCO check runs on every push and pull request and fails on any commit without the trailer; a pull request cannot be merged while it fails. To catch it before you push, enable the repository hooks once per clone:

```bash
git config core.hooksPath .githooks
```

The same setting turns on a second hook: before each commit, Biome checks the staged files (format, lint, import order), which is what the `lint` job checks on the pull request. `pnpm format` fixes most of what it names. The job stays the rule; the hook only tells you earlier. `pnpm env:doctor` says whether the hooks are on.

If you forgot, sign off after the fact:

```bash
git commit --amend -s --no-edit
```

For several commits on a branch, rebase with sign-off:

```bash
git rebase --signoff main
```

Commits made through the GitHub web editor are signed off automatically.

## Local setup

Fifteen minutes from clone to a running app. Prerequisites: Node 22.18 or newer, Docker Desktop or OrbStack, git.

```bash
git clone https://github.com/kuutti-ry/kuutti-app.git && cd kuutti-app
corepack enable                     # pnpm at the version pinned in package.json
cp env.example .env                 # local values only, nothing secret
pnpm install
pnpm env:doctor                     # names anything missing and the fix
pnpm env:up                         # database, storage, mock bank IdP, API, app, admin
```

`env:up` starts Postgres, the S3 stand-in (versitygw) and the mock bank IdP with `docker compose`, migrates and seeds, then runs the API on http://localhost:3000, Metro on http://localhost:8081 (web target and the dev client), and the admin panel on http://localhost:5173, with prefixed logs. Ctrl+C stops the apps; `pnpm env:down` also stops the containers; `pnpm env:status` shows who holds which port. Without Docker, `env:up` falls back to Homebrew PostgreSQL and the storage and IdP stand-ins are unavailable.

Checks that everything is right:

- `curl -s localhost:3000/health` shows `"db":"ok"` and `"migrations":"current"`.
- http://localhost:8081 shows the API version and commit.
- `node services/mock-idp/verify.ts` runs a bank login against the mock IdP, as every persona and as somebody else. The mock bank's login page has a button per persona (`services/mock-idp/README.md`): sign in from the app in the simulator or emulator, tap a name, and you are that person (a phone cannot reach a mock bank that listens on the computer's loopback address).

On a phone, install the dev client build (see `apps/mobile/README.md`), open it, and connect to Metro on this machine; the API URL is derived from the Metro host. The real Telia test bed exists only on staging.

## Pull request previews

Every pull request from this repository gets a comment with three previews (#9): the API of that commit on the staging box with its own seeded database, the web target of the app on EAS Hosting pointed at that API, and, when native code, auth, push or camera changed, an EAS Update for the dev client with a QR code. They appear within about ten minutes of a push and disappear when the pull request closes or after seven days. At most three pull requests hold a preview at a time; the fourth gets a comment saying so. Forks and Dependabot get none: a preview needs the repository's own secrets. Details in `infra/README.md`, Previews.

## Releases

A release is an annotated tag on `main`, made by the maintainer:

```sh
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

The tag retags the image `main` already built for that commit, so production runs the bytes staging ran; applies the production infrastructure and deploys behind the `prod` environment's approval, then publishes the EAS Update to the `production` channel; starts the production builds on EAS, whose links are on the project's builds page (https://expo.dev/accounts/kuutti/projects/kuutti/builds); and drafts the release notes from the commits since the previous tag. Hotfix: branch from the last tag, pull request, tag, merge back (TD-2).

## Branch and history rules

- `main` is the only long-lived branch. It cannot be deleted or force-pushed, and nothing reaches it except a squash-merged pull request whose checks are green.
- Work on a branch of this repository (members of the `contributors` team have write) or on a fork; open the pull request against `main` with `Refs #<issue>` in the body (the `issue-link` check refuses a missing reference and a closing keyword: an issue closes when the maintainer has tested it, not when a merge happens).
- A pull request from a contributor needs one approving review, and one more when its changes are attributed to no person (a coding agent's pull request); the preview lanes (API, web, native) run only after the maintainer has approved the run, because they hold the staging and Expo tokens (ADR-004). Their removal needs nobody: a sweep from `main`, started by every merge, retires the previews of closed and merged pull requests (ADR-012).
- History is linear: no merge commits. Pull requests are squash-merged, nothing else (the ruleset allows only squash).
- Dependency updates arrive as Dependabot pull requests.

## Secrets

Never commit credentials, tokens, private keys, or `.env` files. Push protection and a secret scanner run on every push; if either fires, rotate the secret first, then fix the commit.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Do not open a public issue for a vulnerability.
