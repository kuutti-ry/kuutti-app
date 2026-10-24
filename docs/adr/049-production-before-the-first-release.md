# ADR-049: Production stands up before the first release

- Status: proposed (#25, on the maintainer's answers of 2026-10-24: the tag applies production and the release gate holds, production stays up afterwards, the budget is 110 USD; applied on 2026-10-24 from `v0.64.8-rehearsal.1`, the API deployed by hand, #25; accepting it, swap in production and bank identification are the maintainer's)
- Date: 2026-10-24
- Follows: TD-4 (one vendor, AWS; the budget of 50 EUR a month), TD-19 (RDS, the parameter store and the instance role), ADR-001 (production applied by CI behind the `prod` environment's approval on a `v*` tag), ADR-028 (the counted version and its tags), ADR-046 (swap in production, open), ADR-048 (nothing public reaches Dokploy before it has its owner, #437), rules/i18n.md (the release gate), CLAUDE.md rules 1 and 2; issue #25 and the maintainer's comment on it of 2026-10-24 (bank identification in production on hold)

## Context

On 2026-09-14 the maintainer decided that staging is applied at once and production at the first release (`infra/README.md`, Cost): production costs money from its first day and has nothing to serve before the product exists. Two things have changed since. The association expects AWS credit of 1000 USD. And production's path has never run: `infra-prod.yml` has no run, no `v*` tag exists, the `prod` environment holds no Dokploy values, and most of #25's boxes can only be ticked against a real production. A first apply on release day would find its problems on release day.

Bank identification in production is on hold (Telia's production metadata, the comment on #25), so production cannot serve anyone yet, whenever it is applied.

## Decision

1. **Production is applied now and stays up**, as a rehearsal of #25's procedure without bank identification. `telia_client_id` stays null, so the API boots with bank identification off and answers 503 to a sign-in. No hetu HMAC key, Telia keys or CloudFront signing key are made for it until the real start: the HMAC key is never rotated (rule 2) and belongs to the day real people arrive, made onto the offline medium with Telia's keys.
2. **The tag is a pre-release of the counted version,** `v<main's version>-rehearsal.<n>`, cut by the maintainer on main's tip after the tag ruleset exists (`infra/README.md`, Tag ruleset). It runs `infra-prod.yml` behind the `prod` approval. On the same tag the release gate (`pnpm i18n:check --release`) stops `build.yml` and `eas-build.yml` while Finnish texts wait for their review, as it stops any release: no image retag, no production deploy by CI, no EAS build, no release draft. The gate is not waived. The API reaches the box through `dokploy-setup.sh`, which deploys `:main`, and is then deployed again by hand on a pinned, attested commit (`.github/scripts/dokploy-deploy.sh`, `gh attestation verify` with `--signer-workflow` and `--source-ref`, `docs/security-checklist.md`).
3. **The budget is 110 USD a month while production exists,** the maintainer's figure (TD-4's 50 EUR was the 55 USD for staging alone). Staging and production together come to about 90 to 95 USD a month at list price, so the 80 % alert, at 88 USD, fires on a month with more than the two. The budget counts usage before credits (`include_credit = false`). Netted, as AWS Budgets does by default (`IncludeCredit` true on the budget on 2026-10-24), the credit would keep it near zero while the credit lasts and hide a cost that runs away. The billing alarm keeps the same threshold.
4. **Production's sizes stay as composed:** `t4g.small`, `db.t4g.small` with deletion protection, and no swap until ADR-046's open point is answered.
5. **Production lags `main` between tags.** Every pull request under `infra/` plans production, and only the next `v*` tag and its approval apply it. A tag not meant for production is refused at the approval.
6. **The deployment view draws production as built** in the change after the apply (`docs/architecture/deployment.md`, part 5); until then it draws it as composed and not applied.

## Consequences

- Cost: about 55 USD a month for production at list price, before VAT, while the credit lasts. October's bill to 2026-10-24 carried 5.92 USD of tax on 23.20 USD of usage (Cost Explorer), about 25 %.
- #25's boxes gain evidence from a real production, written to #25 as each step runs. The boxes only a release can tick stay open: the tag's retag and CI deploy, the EAS production builds, update signing.
- Nobody can sign in to production until bank identification resumes. Production's mail stays off in practice too: SES's identity for `kuutti.app` did not exist on 2026-10-24 (the bootstrap declares it, unapplied), and the account is in SES's sandbox.
- The new budget is applied alone, with `-target=aws_budgets_budget.monthly -target=aws_cloudwatch_metric_alarm.estimated_charges`. On 2026-10-24 the bootstrap's plan also held 13 other changes never applied: the SES identity with its records (`infra/README.md`, Mail, step 1), the weekly export's role (#16), the state bucket's lifecycle, and the apex's null MX and `v=spf1 -all`. The last two would replace the Google Workspace records the apex carries today (MX `smtp.google.com`, an SPF including Google's, Google's site verification) and stop the domain's mail. Bringing the bootstrap and the apex's records into one state is a change of its own, the maintainer's to decide.

## Open, the maintainer's

- **Swap in production** (ADR-046).
- **Bank identification** when it resumes: Telia's production keys and the HMAC key onto the offline medium, `telia_client_id`, and the custody rows (the comment on #25).

## Alternatives considered

- **Waiting for the first release** (the decision of 2026-09-14): the first apply would be tried on release day.
- **A rehearsal torn down within the week:** a local apply to lift deletion protection, a local destroy, and every box step again at the real start, to save about 55 USD a month the credit pays.
- **Waiving the release gate for rehearsal tags:** it would prove the retag and the CI deploy too, at the price of switching off a release rule on a release tag.
