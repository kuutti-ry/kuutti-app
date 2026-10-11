# Kuutti

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/kuutti-ry/kuutti-app/badge)](https://scorecard.dev/viewer/?uri=github.com/kuutti-ry/kuutti-app)

A free, open-source dating app for Finland. No ads, no premium tiers, no data sales. Every account is a real adult verified through Finnish bank identification. Run by a non-profit association, built as a hobby by volunteers, with research partners onboard.

Milestone 1 (the skeleton) is in progress: a Hono API on AWS (`infra/`), an Expo app (`apps/mobile`), a moderation panel (`apps/admin`), shared contracts and database packages, and the CI that deploys staging on every merge. `CLAUDE.md` carries the standing rules, `docs/adr/` the decisions, `CONTRIBUTING.md` the fifteen-minute local setup.

## Run it locally

You need git, Node 22.18 or newer, and Docker (Docker Desktop or OrbStack). Six commands, about fifteen minutes; [CONTRIBUTING.md](CONTRIBUTING.md#local-setup) has the detail.

```bash
git clone https://github.com/kuutti-ry/kuutti-app.git && cd kuutti-app
corepack enable                    # pnpm, at the version the project pins
cp env.example .env                # local values only, nothing secret
pnpm install
pnpm env:doctor                    # names anything missing, with the fix
pnpm env:up                        # database, storage, mock bank login, API, app, admin
```

Then open http://localhost:3000/health (the API), http://localhost:8081 (the app, in a browser) and http://localhost:5173 (the moderation panel). Ctrl+C stops the apps; `pnpm env:down` also stops the database. On a phone, install the development build from the project's [builds page on Expo](https://expo.dev/accounts/kuutti/projects/kuutti/builds) and point it at Metro on this machine (`apps/mobile/README.md`).

By hand, one piece at a time (this is what `env:up` does for you), each in its own terminal:

```bash
docker compose up -d --wait                              # Postgres, S3 stand-in, mock bank login
pnpm --filter @kuutti/db migrate                         # apply the migrations
pnpm --filter @kuutti/db seed --env development          # ponds and matching_config
pnpm dev                                                 # API on 3000, restarts on change
pnpm dev:mobile                                          # Metro on 8081; press w for the browser
pnpm dev:admin                                           # moderation panel on 5173
```

## Licence

AGPL-3.0 with App Store exception.

The code is licensed under the GNU Affero General Public License, version 3, see [LICENSE](LICENSE), with an additional permission under section 7 that allows distribution through app stores whose terms conflict with the AGPL, see [LICENSE-EXCEPTION](LICENSE-EXCEPTION).

The licence covers the code, not the name or the look: a fork needs its own name and emblem, see [TRADEMARKS.md](TRADEMARKS.md). Whoever runs the code as a service offers its source to the users of that service (AGPL section 13): the API names it in `GET /health` (`source`, with the running `commit`), and the app and the moderation panel show both. A modified deployment sets `SOURCE_URL` to its own repository.

One directory is licensed differently: `packages/tunnistus-oidc`, the Telia Tunnistus relying-party kit, is MIT (its own `LICENSE`; ADR-017), so that any Finnish relying party can take it.

Dependencies stay within the licences listed in [scripts/license-policy.json](scripts/license-policy.json), so that nothing copyleft without an equivalent store permission ends up in the app (`pnpm check:licenses`).

## Contributing

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Contributions are accepted under the Developer Certificate of Origin. Every commit needs a `Signed-off-by` line, added with `git commit -s`. Details in [CONTRIBUTING.md](CONTRIBUTING.md) and the [DCO](DCO) file.

## Security

Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).
