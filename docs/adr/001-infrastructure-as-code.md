# ADR-001: Infrastructure as code with OpenTofu

- Status: proposed (built in `infra/` and applied to staging, and to production on 2026-10-24, ADR-049; accepting it is the maintainer's), amended 2026-09-13 (#6: admin access through IAM Identity Center), 2026-09-17 and 2026-09-18 (the domain; the placeholder page), 2026-09-28 (the site moved to a repository of its own) and 2026-10-03 (#110: the organisation renamed)
- Date: 2026-09-12
- Follows: TD-4 (single-vendor AWS, eu-central-1), TD-19 (RDS, SSM, instance role)

## Context

Every runtime dependency except Telia, Expo and GitHub is an AWS resource in one account in eu-central-1. The stack is small (one EC2 instance, one RDS instance, S3, CloudFront, SES, IAM, CloudWatch) but several of its resources are security-relevant: security groups, IAM roles, bucket policies, and the CloudFront signing configuration.

Four things make codifying it worth the effort at this size:

1. The single box is a single point of failure. Recovery should be an apply plus a snapshot restore, not archaeology.
2. The repository is public and AGPL. Infrastructure that can be read and reviewed is part of the transparency the project claims.
3. Ownership transfers to the association later. Code transfers; console clicks do not.
4. Infrastructure changes get the same pull request review as application changes, which matters most for exactly the security-relevant resources listed above.

## Decision

**OpenTofu**, with the AWS provider, state in S3 with native locking.

Layout:

```
infra/
  bootstrap/        state bucket, GitHub OIDC provider, CI roles, budget and billing alarm. Run once, locally.
  modules/
    network/        VPC, subnets, route tables, security groups, DB subnet group
    data/           RDS instance, parameter group, backups
    compute/        EC2, EBS, Elastic IP, instance profile and role, user_data
    media/          S3 buckets, CloudFront, OAC, cache and origin request policies, ACM
    email/          not built: the SES identity is the domain's, bootstrap/mail.tf (ADR-043 §5)
    observability/  log groups, alarms
  envs/
    staging/ prod/
  github/           repository settings, branch protection, environments
```

State: one S3 bucket, one key per environment, versioned and encrypted, `use_lockfile = true`. DynamoDB locking is deprecated and is not used.

CI: GitHub Actions assumes an AWS role by OIDC. `tofu plan` runs on every pull request and posts the plan. Apply to staging happens on merge to `main`; apply to production requires approval through a GitHub environment protection rule.

Two roles. The plan role has `ReadOnlyAccess` minus data: it is explicitly denied `kms:Decrypt` (so it cannot read SecureString parameters under the default key), Secrets Manager reads, CloudWatch log reads, and `s3:GetObject` outside the state bucket, because it is assumable from any pull request. The apply role has `PowerUserAccess` plus scoped IAM, and can only create or modify roles that carry a permissions boundary shaped like `PowerUserAccess`, so it cannot mint a role more powerful than itself.

### Out of scope, deliberately

- **Dokploy's own configuration.** No provider exists. Terraform provisions the box and `user_data` installs Dokploy; the applications, domains and preview settings inside it are configured separately and backed up from `/etc/dokploy`. This is the one manual step in the recovery path, and it is an argument in the open Dokploy versus Kamal question (Kamal keeps deploy configuration in the repository, so apply plus deploy rebuilds everything from source).
- **Secret values.** Secret parameters are not declared as resources. The AWS provider stores a SecureString's decrypted value in state on every refresh, and `ignore_changes` only suppresses the diff, so a placeholder-plus-ignore pattern would put the value into state after the first refresh. Secrets are created once with the CLI and referenced by path in IAM policies; only non-secret parameters live in code. Write-only attributes (`value_wo`, OpenTofu 1.11+) are the fallback if a secret ever has to be managed in code.
- EAS and Expo configuration, Apple and Google store setup, the Telia contract, and creation of the AWS account itself.

### State hygiene

The state file is a secret store and is treated as one: versioning, encryption, public access blocked, access limited to the CI roles and the maintainer.

RDS uses `manage_master_user_password = true` so the master password is generated and held by AWS in Secrets Manager and never appears in state. This is the reason Secrets Manager appears here despite being listed as "not adopted" in the infrastructure rules: it is used by RDS, not by the application, which continues to read its own secrets from SSM Parameter Store.

### Admin access for the bootstrap apply

Added 2026-09-13 (#6). The one human identity in the account is an **IAM Identity Center** user for the maintainer with a single `AdministratorAccess` permission set; the CLI gets short-lived credentials through `aws configure sso`. No IAM user and no long-lived access key exist, which is what the "no static keys anywhere" rule requires. The cost is that Identity Center needs AWS Organizations, so enabling it makes this account the management account of a one-account organisation, and creating an organisation expires the USD 100 sign-up credits (AWS Free Tier FAQ); the credits are worth less than never holding a static key. When the account later moves under an organisation owned by the association, that organisation and its Identity Center instance are deleted first, the invitation is accepted, and admin access is re-created on the association's side. Everything under `infra/` survives that move unchanged; only the human login is rebuilt. The fallback, if Identity Center cannot be enabled, is one IAM user with MFA and console-issued session credentials, still with no access key.

### The domain

Added 2026-09-17. The project domain `kuutti.app` is registered through Route 53 in this account, so it transfers with the account (TD-4) and needs no second vendor. Registration is a purchase with registrant contact details and is done in the console, the same exception as creating the account. Route 53 creates the hosted zone at registration; the bootstrap adopts it with an import block instead of creating a second zone, whose name servers the registration would not point at. This is the one sanctioned import of a console-created resource. Records are declared by the environment that owns their target.

Added 2026-09-18. The placeholder page for `kuutti.app` (`site/`, no build step) is served by Amplify Hosting connected to this repository, which deploys on every push to `main` that touches `site/`. The Amplify app is created in the console, the second sanctioned console resource: connecting Amplify to GitHub is an installation of the Amplify GitHub App, a browser consent no provider can perform, and the alternative the provider offers, a personal access token stored in state, is what this ADR forbids. Amplify also writes the certificate-validation and alias records for the domain into the zone; they stay unmanaged, like the registration itself. The app holds no IAM role and no data, and is deleted with one call when a real site replaces it.

Retired 2026-09-28: the site has a repository of its own, `kuutti-ry/kuutti-app-site`, and the Amplify app serving `kuutti.app` is connected to that one under the same exception (`infra/README.md`, "The website"); `site/` and `amplify.yml` are gone from this repository.

### GitHub OIDC trust, specific to this repository

`kuutti-app` was created after 15 July 2026, so it uses GitHub's immutable subject claims. The subject is `repo:kuutti-ry@<owner_id>/kuutti-app@<repo_id>:...`, not the name-based form shown in most documentation and examples. Trust policies therefore condition on the `repository_id` and `repository_owner_id` claims, which are stable and survive renames, rather than pattern-matching the name inside `sub`. A policy copied from an older example will fail to assume with an unhelpful error.

Added 2026-10-03. The organisation was renamed from `kuutti-fi` to `kuutti-ry` on that day (#110). Both IDs stayed, so the trust policies and the roles needed no change and nothing was applied; the name inside `sub` is the only part of a token that differs.

## Consequences

- Bootstrap is the only click-ops: create the AWS account, enable MFA, convert to a paid plan, then run `infra/bootstrap` locally with local state and migrate the state into the bucket it just created.
- Everything after that is written as code from the first resource. Resources are not created in the console and imported later.
- Module rollout follows the milestones: network, compute, data, IAM and the CI role in M1; media and delivery in M3 when photos exist; email in M5.
- A contributor can read the whole infrastructure without an AWS login.

## Alternatives considered

**Terraform.** Functionally equivalent and the provider ecosystem is the same. Rejected on licensing: the Business Source Licence permits this use, but for a public, association-owned, AGPL project OpenTofu under MPL-2.0 avoids the question entirely and costs nothing. Migration between the two remains possible in either direction.

**AWS CDK in TypeScript.** Genuinely attractive for a TypeScript monorepo: same language, same repository, real types. Rejected because it compiles to CloudFormation and inherits its failure modes, in particular stacks that wedge in `UPDATE_ROLLBACK_FAILED`, slow applies, and stack-level coupling. For a solo operator whose single box cannot afford to be stuck, an explicit plan and per-resource state are worth more than language consistency.

**CloudFormation directly.** Its historical advantages (day-one support for new services, StackSets, Service Catalog) do not apply to a single-account stack of long-established services. Its changesets are also a weaker review artefact than a plan.

**No IaC, console plus a runbook.** Cheapest today and the usual choice at this size. Rejected for the four reasons in the context section, of which transfer to the association and reviewability of security-relevant resources are the ones that do not go away.

## History

- 2026-10-24 (#397): the layout's `email/` module was never built. Mail's SES identity belongs to the domain, so it went to `bootstrap/mail.tf` with #385 (ADR-043 §5). The modules that came later, `admin` (ADR-025) and `research` (ADR-029), and the deployment they make are in `infra/README.md`'s layout and in `docs/architecture/`.
