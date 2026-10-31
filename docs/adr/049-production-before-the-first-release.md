# ADR-049: Production stands up before the first release

- Status: proposed (#25, on the maintainer's answers of 2026-10-24: the tag applies production and the release gate holds, production stays up afterwards; applied on 2026-10-24 from `v0.64.8-rehearsal.1`, the API deployed by hand, #25; accepting it and bank identification are the maintainer's), amended 2026-10-31 (§2: the panel by hand from the tag; §3: the budget is 150 USD; §4: a t4g.medium and no swap; on the maintainer's word once the AWS credit was on the account; see History)
- Date: 2026-10-24
- Follows: TD-4 (one vendor, AWS; the budget of 50 EUR a month), TD-19 (RDS, the parameter store and the instance role), ADR-001 (production applied by CI behind the `prod` environment's approval on a `v*` tag), ADR-028 (the counted version and its tags), ADR-046 (no swap in production), ADR-048 (nothing public reaches Dokploy before it has its owner, #437), rules/i18n.md (the release gate), CLAUDE.md rules 1 and 2; issue #25 and the maintainer's comment on it of 2026-10-24 (bank identification in production on hold)

## Context

On 2026-09-14 the maintainer decided that staging is applied at once and production at the first release (`infra/README.md`, Cost): production costs money from its first day and has nothing to serve before the product exists. Two things have changed since. The association expects AWS credit of 1000 USD. And production's path has never run: `infra-prod.yml` has no run, no `v*` tag exists, the `prod` environment holds no Dokploy values, and most of #25's boxes can only be ticked against a real production. A first apply on release day would find its problems on release day.

Bank identification in production is on hold (Telia's production metadata, the comment on #25), so production cannot serve anyone yet, whenever it is applied.

## Decision

1. **Production is applied now and stays up**, as a rehearsal of #25's procedure without bank identification. `telia_client_id` stays null, so the API boots with bank identification off and answers 503 to a sign-in. No hetu HMAC key, Telia keys or CloudFront signing key are made for it until the real start: the HMAC key is never rotated (rule 2) and belongs to the day real people arrive, made onto the offline medium with Telia's keys.
2. **The tag is a pre-release of the counted version,** `v<main's version>-rehearsal.<n>`, cut by the maintainer on main's tip after the tag ruleset exists (`infra/README.md`, Tag ruleset). It runs `infra-prod.yml` behind the `prod` approval. On the same tag the release gate (`pnpm i18n:check --release`) stops `build.yml` and `eas-build.yml` while Finnish texts wait for their review, as it stops any release: no image retag, no production deploy by CI, no EAS build, no release draft. The gate is not waived. The API reaches the box through `dokploy-setup.sh`, which deploys `:main`, and is then deployed again by hand on a pinned, attested commit (`.github/scripts/dokploy-deploy.sh`, `gh attestation verify` with `--signer-workflow` and `--source-ref`, `docs/security-checklist.md`). The panel gets there by hand too (amended 2026-10-31): the maintainer starts `admin-deploy.yml` from the tag, behind the same approval. The gate holds Finnish texts, and the panel is English only.
3. **The budget is 150 USD a month while production exists,** the maintainer's figure (amended 2026-10-31; first 110 USD, see History; TD-4's 50 EUR was the 55 USD for staging alone). Staging and production together come to about 105 to 110 USD a month at list price, or about 115 with one WAF (#41), so the 80 % alert, at 120 USD, fires on a month with more than the two. The budget counts usage before credits (`include_credit = false`). Netted, as AWS Budgets does by default (`IncludeCredit` true on the budget on 2026-10-24), the credit would keep it near zero while the credit lasts and hide a cost that runs away. The billing alarm keeps the same threshold.
4. **Production's sizes:** a `t4g.medium` (amended 2026-10-31; first a `t4g.small`, see History), `db.t4g.small` with deletion protection, and no swap (ADR-046 §1).
5. **Production lags `main` between tags.** Every pull request under `infra/` plans production, and only the next `v*` tag and its approval apply it. A tag not meant for production is refused at the approval.
6. **The deployment view draws production as built** in the change after the apply (`docs/architecture/deployment.md`, part 5); until then it draws it as composed and not applied.

## Consequences

- Cost: about 70 USD a month for production at list price, before VAT, while the credit lasts (about 55 USD until the `t4g.medium`). October's bill to 2026-10-24 carried 5.92 USD of tax on 23.20 USD of usage (Cost Explorer), about 25 %.
- #25's boxes gain evidence from a real production, written to #25 as each step runs. The boxes only a release can tick stay open: the tag's retag and CI deploy, the EAS production builds, update signing.
- Nobody can sign in to production until bank identification resumes. Production's mail stays off in practice too: SES's identity for `kuutti.app` did not exist on 2026-10-24 (the bootstrap declares it, unapplied), and the account is in SES's sandbox.
- The new budget is applied alone, with `-target=aws_budgets_budget.monthly -target=aws_cloudwatch_metric_alarm.estimated_charges`. On 2026-10-24 the bootstrap's plan also held 13 other changes never applied: the SES identity with its records (`infra/README.md`, Mail, step 1), the weekly export's role (#16), the state bucket's lifecycle, and the apex's null MX and `v=spf1 -all`. The last two would replace the Google Workspace records the apex carries today (MX `smtp.google.com`, an SPF including Google's, Google's site verification) and stop the domain's mail. Bringing the bootstrap and the apex's records into one state is a change of its own, the maintainer's to decide.

## Open, the maintainer's

- **Bank identification** when it resumes: Telia's production keys and the HMAC key onto the offline medium, `telia_client_id`, and the custody rows (the comment on #25).

## Alternatives considered

- **Waiting for the first release** (the decision of 2026-09-14): the first apply would be tried on release day.
- **A rehearsal torn down within the week:** a local apply to lift deletion protection, a local destroy, and every box step again at the real start, to save about 55 USD a month the credit pays.
- **Waiving the release gate for rehearsal tags:** it would prove the retag and the CI deploy too, at the price of switching off a release rule on a release tag.

## History

- 2026-10-31 (#25, #77): the credit, 1,000 USD through TechSoup, is on the account, and the maintainer took three steps on it. Production becomes a `t4g.medium`, about 14 USD a month more at list price, in place of swap: with the API running the `t4g.small` had 264 to 280 MiB available against the memory alarm's 200, and a larger box answers ADR-046's open point without a page of the API's memory reaching the disk. The panel's host is composed (ADR-025), and the panel goes from a rehearsal tag by hand, so that its first deploy is not tried on release day either. The budget is 150 USD, since about 115 USD with one WAF would pass 110 every month. At that rate the credit lasts some nine months before VAT. The bootstrap's plan is whole since #451, so the new budget goes with a plain apply, not the `-target` of 2026-10-24 under Consequences.
