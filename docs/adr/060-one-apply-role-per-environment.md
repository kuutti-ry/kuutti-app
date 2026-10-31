# ADR-060: One apply role per environment

- Status: proposed (nothing built; no code follows until the maintainer has chosen among the options here; needed before production has bank identification, which is on hold, ADR-049)
- Date: 2026-10-31
- Follows: TD-4 (one vendor, AWS), TD-19 (the parameter store and the instance role), ADR-001 (the CI roles, the permissions boundary), ADR-004 §2 to §4 (what `EXPO_TOKEN` reaches), ADR-012 §9 (an environment with no ref policy), ADR-018 (staging holds invented people), ADR-025 (its Open list names this), ADR-043 §6 (staging shares production's sending reputation), ADR-049 (production runs without bank identification), ADR-053 (record-name conditions in DNS), CLAUDE.md rule 2, rules/infra.md; issue #25; the security review of #549

## Context

`infra/bootstrap` makes one role, `kuutti-ci-apply`: AWS's `PowerUserAccess` plus scoped IAM. Its trust admits the GitHub environments `staging` and `prod` alike (`local.sub_environments`). `prod` takes `v*` tags behind the maintainer's approval; `staging` takes `main` and has no reviewer. So the approval gates a job and not the role, and a commit on `main` reaches all of production with nobody asked, in three ways:

- `infra.yml`'s `apply staging` applies whatever `envs/staging` declares, and that can name production's resources;
- `admin-deploy.yml`'s staging job writes a bucket named by a variable, and the role could as well write production's;
- any new workflow on `main` can name `environment: staging` and take the role.

The pull request's review is all that stands in the way, one approval, which `auto-approve.yml` gives the maintainer's own pull requests.

This is not new with #549, but it matters more from here. Production's panel will hold staff sessions and take the bank's one-time code, so a script on that origin is a staff takeover once production has bank identification. And the role can decrypt every SecureString: `PowerUserAccess` allows `ssm:GetParameter`, and under the default `aws/ssm` key that is enough, which is why the plan role carries an explicit deny (`ci_plan_deny_data`). That will include the hetu HMAC key, which rule 2 keeps in the parameter store and which can never be rotated.

Today nothing is at stake: production has no people, no HMAC key and no Telia keys (ADR-049 §1).

## What a second role buys, and what it does not

**Trust alone buys nothing.** Both environments live in one account, and PowerUser is a right over the account, not over an environment. Two PowerUser roles, each trusting one environment, leave `staging` able to do everything it can do today, production included. CloudTrail would name a different role, and that is the whole change. The real work is the policy, and only one of the two roles needs it: `staging` is the side with no person in front of it.

**With a scoped staging role,** no run from `main` can act on production's AWS resources through that role, however it got there: not the panel's bucket, not `/kuutti/prod/*`, not the box, not the database, not production's state. The role that can sits behind a `v*` tag and the reviewer.

**It does not buy:**

- **`main`'s code.** What lands on `main` is production's code at the next tag. The split removes the immediate, unattended path, and leaves a reviewer and some time. It does not read the code.
- **Rule 2 against the production role.** Whoever can apply production can replace its box, and a box with the instance role reads what the API reads. An approved `prod` job can always reach the HMAC key, because applying production is that job. What guards the key from it is the tag ruleset and the reviewer, as today.
- **The image.** `deploy prod` takes `:vX.Y.Z`, which `build.yml` retags from `:<sha>`, and nothing in CI verifies either. Every pull request's `image` job holds `packages: write` from the branch's own copy of the workflow, so a branch can replace either tag, with no review, and the reviewer's click does not see it. `delivery.md`'s Open list has half of this.
- **The build cache.** A tag's run restores `main`'s Actions cache, so a `main` job can leave a pnpm store behind for production's panel build and for `deploy.yml`.
- **The phones.** `staging` holds `EXPO_TOKEN`, which can publish to the `production` channel (ADR-004 §2). ADR-004 §4 keeps its own date: before a production build reaches anyone outside the team.
- **What the account shares.** SES's reputation and suppression list (ADR-043 §6), service quotas, the bill. Staging can still hurt production by using them up.
- **The plan role.** Any pull request still reads production's metadata and state (ADR-001). It can also tail production's logs (`logs:StartLiveTail`) and list SES's suppression list (`ses:List*`): `ReadOnlyAccess` holds both and `ci_plan_deny_data` denies neither, although `rules/infra.md` says log reads are denied.
- **A stolen maintainer login,** which can push a tag and approve it.

The image, the cache and the plan role's two reads are fixes of their own, small ones, and needed as much as this decision. None of them depends on which option is chosen.

## The options

| | can `main` reach production's AWS unattended? | what it costs once | what it keeps costing |
|---|---|---|---|
| A. Two roles, same rights | yes | one bootstrap apply | nothing |
| B. One role, a reviewer in front of it | no, but the approved run holds all of production | an environment and a small role | a click on every merge that starts `infra.yml`: thirty runs from 2026-10-09 to 2026-10-31, about nine a week |
| **C. Two roles, staging's scoped (recommended)** | no | about 150 lines of policy, a second boundary, two objects moved, the maintainer's steps below | a few rare acts stay the maintainer's (point 5); a new service is a bootstrap change |
| D. A second AWS account for staging | no, and nothing to keep in step | a second bootstrap, staging rebuilt, a delegated zone, the rule "one AWS account" changed | two accounts at every login, plan and budget; two to carry to the association |

**A** is named because it is what "one role per environment" sounds like. It is not a fix.

**B** puts a new environment with a reviewer in front of `apply staging`, moves the role's trust there, and gives the panel's upload, which runs on every merge, a small role of its own. About forty lines and no policy to keep. It closes the unattended path. But the run a person approves still holds all of production, and a gate that fires nine times a week stops being read; ADR-004 §3 took the reviewer off `preview` for a cost of that shape. The approvals of `prod` stay rare under C, which is what keeps them worth reading.

**D** is the strongest, and the boundary is AWS's own. It needs none of the policy below, closes ADR-043 §6, and takes previews out of production's account. It has to be staging that moves: Organizations gives a new member account `OrganizationAccountAccessRole`, with full administrative rights there, open to all principals of the management account, and `PowerUserAccess` includes `sts:AssumeRole`. Production in a member account with staging left behind would be no boundary while that role stands, and production's records and mail identity would stay behind with the zone. Moving staging means a second bootstrap (state bucket, OIDC provider, roles), `staging.kuutti.app` delegated, an SES identity of its own, the box, Dokploy and the database rebuilt, the secrets loaded again, the demo seeded again, and ADR-001's move to the association's organisation with two accounts to carry.

**Recommendation: C.** It holds by a rule AWS enforces and not by a person's attention, keeps every merge deploying staging unattended, keeps the one-account rule, and can be undone. It is not free of risk: a first draft of it failed an adversarial review in six places, each of them silently, and points 3 to 8 carry the fixes. That is the case for point 10, and it is what D would spare. C does not close the door on D: it is staging that would move, so D costs about the same later as it does now. What would change this: the acts of point 5 coming more often than monthly, a second failure of this kind, or a wish to end ADR-043 §6's shared reputation as well.

## Option C, in points

1. **Two roles in `infra/bootstrap`.** `kuutti-ci-apply-staging` trusts the environment `staging` and the ref `main`; `kuutti-ci-apply-prod` trusts `prod` and `v*` tags. Both keep today's conditions on the repository and its owner, and hold the token's `environment` and `ref` claims directly, which AWS supports. So the trust repeats the environments' ref policies, which are settings and have been missing before (ADR-012 §9). Today's `sub` pattern is sound as it stands: GitHub writes a `:` inside an environment's name as `%3A`, so no name can spell `:environment:prod` past its `*`. `kuutti-ci-apply` loses `staging` in the same apply, and goes once production has run under its new role.

2. **The production role keeps today's rights,** behind the reviewer. Scoping it would protect staging, which holds invented people (ADR-018), at the price of a second list on a path the maintainer approves each time.

3. **The staging role is the plan role's reads plus scoped writes.** Its reads are `ReadOnlyAccess` and the plan role's denies, with two differences. The exemption for the state bucket shrinks to `staging/*`, or production's state and the backups under `dokploy-backup/prod/` stay readable. And it denies the two reads the plan role lacks. `tofu plan` works under these reads today, so they add nothing a pull request does not hold. Its writes are an allow-list held to staging's resources, with a service's verbs left open only where every resource a verb touches is checked (`s3:*` on staging's buckets, `ec2:*` on what carries staging's tag), so that a new verb on staging's own things needs no bootstrap change. RDS is listed verb by verb and names no snapshot: its restore, copy and replica calls read from a second resource, and a right on `db:kuutti-staging` must not become a copy of `kuutti-prod`. Never PowerUser with denies: PowerUser has too many ways to production's data to list (Run Command on the box, a snapshot of its volume, a restored database, a new box with its role), and a deny list fails open on the one nobody listed. An allow-list fails closed, as a red `apply staging`.

4. **What each service can be held to.** From AWS's service reference, read on 2026-10-31, for what `envs/staging` declares:

   | how a write is held to staging | what |
   |---|---|
   | a name in the ARN | S3 (`kuutti-*-staging-*`, and `staging/*` of the state bucket), SSM parameters and documents, RDS, log groups, alarms, SNS, IAM roles, CloudFront functions |
   | a tag, `aws:ResourceTag/Environment` | EC2 and the VPC, whose ARNs hold random ids; CloudFront distributions, for updates and invalidations |
   | a condition | Route 53 records: the zone's ARN and the record names `*.staging.kuutti.app`, as ADR-053 does |
   | an id alone, no name or tag | CloudFront's cache, response-headers and origin-access-control policies; Route 53 health checks |
   | nothing at all | CloudFront key groups and public keys: their actions take no resource, so a role that can change staging's can change production's, and a key added to production's group signs production's photo URLs |

   The fourth row is pinned: the role names those ids, which reach the bootstrap as an input, read by name from AWS and never from staging's state or outputs, which this role can write. Creating one is allowed, since the call takes no resource and a new object touches nothing, and its first update fails closed until its id is pinned. The last row gets reads only. Saved log queries take no resource either (`logs:PutQueryDefinition`) and are harmless enough to allow.

5. **Nothing with more rights runs over state this role can write.** The staging role writes `staging/terraform.tfstate`, so it could make that state say a staging object has production's id, and an apply with more rights would then act on production, with the plan as the only warning. So the role does all it safely can, and five rare, deliberate acts stay outside it: rotating a signing key, rebuilding the box (no `ec2:RunInstances`, no `iam:PassRole`), adding a host (no new distribution or certificate), adding a role (no `iam:CreateRole` or `iam:DeleteRole`), and changing the research trail (no `cloudtrail:PutEventSelectors`, which could log production's object calls). Each is the maintainer's, by `-target` or `-replace`, after reading the diff of `infra/` and the plan for production's ids: a `data "external"` runs at plan, on the maintainer's machine. Without `PassRole`, no run can start a box as production's instance role.

6. **The traps in the writes.** Each is silent if missed.
   - Tags can be changed. `ec2:CreateTags` needs staging's tag on the resource already, or `ec2:CreateAction`, and never passes on a tag in the request alone, or the role relabels a production resource `staging` and takes it. The role gets no `cloudfront:TagResource`. A resource with no tag fails the condition, so a gap in tagging fails closed.
   - `aws:RequestTag` goes on the ARNs of new resources alone: on `Resource: *` it also passes the source, and `ec2:CreateSnapshot` of production's volume goes through. No snapshot, volume or image creates at all.
   - An alarm can act. `cloudwatch:AlarmActions` is held to staging's topics, or an alarm named for staging can terminate production's box by its `InstanceId`.
   - No `cloudfront:AssociateAlias`, which moves a name between distributions.

7. **Two account-wide objects leave staging.** `manage_session_preferences` has staging declare `SSM-SessionManagerRunShell` and the log group `/kuutti/ssm-sessions`, and they govern production's sessions too: a role that can edit them can turn off the log of a shell on production's box. They move to the bootstrap, out of staging's state without being destroyed.

8. **A second boundary.** Today's boundary has PowerUser's shape, which holds a role to "no stronger than the apply role" and no more. It does nothing here: the staging role must edit `kuutti-api-staging`, and a policy there naming `/kuutti/prod/*` would pass it, for the box and every preview that runs under that role. So `kuutti-boundary-staging`, an allow-list of what staging's two roles do, with the conditions their own policies carry, since a policy this role can edit is no guard: their parameters and KMS through SSM and S3, their buckets and the put under `dokploy-backup/staging/`, their log groups and `/kuutti/ssm-sessions`, `cloudwatch:PutMetricData` in their namespace, the agent's calls, Rekognition, SES under `ses:FromAddress` and `ses:Recipients`, and the preview certificate's TXT record by its name. The staging role may edit only roles that carry it, `kuutti-api-staging` and `kuutti-staging-research-read`, and may set it and no other on those two. Neither apply role may edit a boundary policy or any `kuutti-ci-*` role (today's denies name the plan and apply roles alone). A gap in a boundary does not show as a red run: it shows on the box, as a failed boot or a backup that silently did not land. So the instance role's actions go through `iam simulate-principal-policy` against the new boundary before the role moves onto it, and the next night's backup is looked for.

9. **The ARNs.** `AWS_APPLY_ROLE_ARN` moves from a repository variable to one of the same name in each of `staging` and `prod`. The environment's wins, so no job changes; only `infra-oidc.yml`'s check of the role's name does. The variable is not the control: a job in `staging` that names production's ARN is refused by the trust. Nothing in the repository yet shows a job-level `env:` reading an environment's variable, so the `gate` dispatch right after the merge is the proof; should it come back empty, the jobs set `AWS_ROLE_ARN` in a step instead. The repository variable is deleted last.

10. **A check that can fail.** `infra-oidc.yml` gains a job in `staging`, on `main`, that tries what must be refused, each call harmless if it were to succeed: a canary object under `prod/` of the state bucket, decrypting the throwaway parameter, `true` by Run Command on production's box, assuming `kuutti-ci-apply`; and `iam simulate-principal-policy` for what cannot be tried, the traps of point 6 among them. Nothing else would show a policy widened by accident.

11. **The rest follows the code:** ADR-001's "Two roles" and its apply paragraph, ADR-025's Open list, `rules/infra.md`, `infra/README.md`, the security checklist, and the drawings `pnpm check:docs` names (`delivery.md`, `context.md`, and `deployment.md` and `trust.md` where the bootstrap or a module they draw moves).

### The maintainer's steps

CI neither plans nor applies the bootstrap, and it owns these roles, so a commit on `main` can never widen them. That is why the policy lives there. It also means the steps are the maintainer's, with the pull request open:

1. `pnpm aws:login`, then `tofu -chdir=infra/bootstrap plan` from the branch, with the ids of point 4 in the tfvars; read it, and apply. The new roles and boundary appear, `kuutti-ci-apply` loses `staging`, and the two objects of point 7 are adopted.
2. Set the two variables at once from `tofu output` (`gh variable set AWS_APPLY_ROLE_ARN --env staging --body …`, and `--env prod`). No environment's reviewer or branch policy changes.
3. Approve and merge. `apply staging` runs under the new role, moves staging's two roles onto their boundary and lets go of the two objects. A red run here names what the allow-list lacks: it is fixed in the bootstrap and applied by hand, and production is not touched either way.
4. `gh workflow run infra-oidc.yml --ref main -f gate=staging`, and with `gate=prod` from the next `v*` tag, whose `apply prod` is the first under the new role. That tag is the rehearsal of ADR-049 §2.
5. Once both are green: `gh variable delete AWS_APPLY_ROLE_ARN`, and a last small pull request takes `kuutti-ci-apply` out of the bootstrap, applied by hand.

## Consequences

- Cost: nothing at AWS. About 150 lines of policy in the bootstrap, which a reviewer of `infra/` has to read, and a list of ids in the maintainer's tfvars.
- A red `apply staging` becomes a normal event: a verb or an id the role does not have. It costs the maintainer a bootstrap apply and never costs production anything. The history says this is rare once the first run has passed: forty-six resource types arrived in five weeks and none since 2026-10-17, and an id-named object has changed once (the panel's CSP gained `font-src`). The next new service in sight is the WAF (#41).
- An agent cannot finish such a run: `tofu apply` is the maintainer's. So a change that needs an act of point 5 says so in its pull request.
- `infra/README.md`'s "a local apply is not the path" and `rules/infra.md`'s "apply to staging on merge" gain their exceptions. A local apply of staging needs CI's two inputs, `TF_VAR_alert_email` and `TF_VAR_mail_recipients`, or it drops the alert subscription; the README gets the command.

## Not checked

No AWS session was open on 2026-10-31, so nothing here was read from the account. All but the last fails closed, as a red run:

- that every EC2 resource staging changes carries `Environment`; a root volume may not (`aws ec2 describe-volumes`);
- that the deny of `kms:Decrypt` lets `apply staging` stop and start the box under its encrypted volume; if it does not, the deny narrows by `kms:ViaService`, since point 3's S3 deny guards the backups as well;
- which writes the apply really makes: CloudTrail's event history keeps ninety days of them under the session names `gha-apply-*`, which is the place to start the list from, before the first run rather than after it;
- whether pnpm's own check of its store would catch a store left in the cache, which sets how urgent that fix is.

## Left out on purpose

- **An operator role for the acts of point 5,** assumed by the maintainer in place of AdministratorAccess: it would bound a mistake in reading a plan, for about thirty lines more. Needed if those acts become frequent.
- **Resource-side guards on production** (a bucket policy naming the writers): the allow-list already refuses these writes, and each guard is one more thing the production role must get past. Needed if the staging role ever regains PowerUser.
- **A customer-managed KMS key for `/kuutti/prod/*`,** whose key policy names the instance role and the maintainer: about 1 USD a month, and a real second lock on rule 2 against everything but an approved `prod` job. It is not part of this decision, and it costs least if chosen before the HMAC key is made.
- **A narrow role for the panel's upload in production:** it would trust `prod` as the apply role does, so a job there could assume either.
- **An SCP:** SCPs do not affect the management account, and this account is one.
- **`staging` itself behind a reviewer:** every merge would ask at each of its jobs, as `preview` asked at each of its lanes until ADR-004 §3 took the reviewer off.

## Open, the maintainer's

- **Which option.** C is the recommendation. Nothing is built until the answer.
- **Whether a customer-managed key for production's secrets** joins before the HMAC key is made (Left out, above).
