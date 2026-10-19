# ADR-033: Automatic shadow bans

- Status: accepted 2026-10-19 (#105, built as written here on the maintainer's decisions of that day, #105's comments; the points under "Open, the maintainer's" are his to confirm or change)
- Date: 2026-10-19
- Follows: TD-5 (moderation; research events never carry text), TD-6 (what a verified stranger learns), TD-7 (shadow_banned; erasure), ADR-024 (sanctions: §3 staff, §6 a shadow ban withholds, §8 erasure, §9 the audit log), ADR-030 (§4 the report, §7 being blocked is no signal, §10 the index #105 adds), ADR-031 (§9 the socket, Open 5 the tells), CLAUDE.md rules 5, 6 and 10 and Product constraints; issues #105, #312, #86, #106

## Context

A moderator cannot watch everything, and the first hours of an abuser cost the most (#105). TD-5 asks for rules that take a person out of others' sight at once when their behaviour looks like abuse, with a moderator always deciding afterwards. #312 left the moderators' review of such bans to #105, and #312's rule for which sanction closes a report as acted on excluded what no person applied. The maintainer set the parameters on 19/10/2026: three reports by different people in seven days; twenty first messages in an hour; the same first message to five people within twenty-four hours, with no minimum length; a forty-eight-hour review that leaves the ban in place, marked late, when it passes; the reports decided one by one, a confirmed ban allowed to close them; and an audit row for the machine's own ban.

## Decision

1. **Three rules, only ever a shadow ban.** A rule applies `shadow_ban` with the reason `other`, by nobody (`created_by` null), with a fixed note per rule. A machine never warns, suspends or bans: the database's `sanction_rule_check` refuses a rule's record on anything but a shadow ban by nobody. Everything a shadow ban does is ADR-024 §6's: the person sees everything as usual, their later lines and photos are withheld, and others see nothing of them.
   - **Reports**: reports filed about the account within `auto_shadow_ban_reports_days` (7) by `auto_shadow_ban_reports` (3) different identities. A dismissed report does not count; a block never does (ADR-030 §7).
   - **First messages**: `auto_shadow_ban_first_messages` (20) conversations opened by the person within `auto_shadow_ban_first_messages_minutes` (60). A first message is a conversation's opener, sequence 1; a reply is not.
   - **The same first message**: the same opener to `auto_shadow_ban_same_first_message` (5) people within `auto_shadow_ban_same_first_message_hours` (24). The same means the same letters and digits after Unicode compatibility folding and lower case: spacing, punctuation and emoji never make two openers differ, and a changed word or number always does. There is no minimum length, so five identical greetings count; a photo with no caption has no words and never counts. When both message rules are met, the same opener is recorded, as the more specific evidence.
   A threshold of 0 switches its rule off. Every value is a `matching_config` row (migration 0065), changed in the panel's tunables (#305) with a reason and a `config.change` row, read on each check.
2. **Where and when a rule runs.** In the request that can trigger it, after that request's transaction has committed and before it answers: the report routes after a report is filed (`checkReports`), and the chat's send routes after a conversation's first message (`checkFirstMessage`, handed to the chat's routes by `app.ts`, so the chat never imports the safety slice). A check is one transaction that first takes the person's sanction lock (`lockAccountForSanction`, the order an erasure and every sanction take), then reads, counts and applies. So two triggers at once apply one ban, and a check never holds a row its trigger wants: run inside the trigger's own transaction it would deadlock exactly at the threshold. A check does nothing for an erased account, for somebody already out of sight (an open shadow ban on the account, an open suspension or ban on the identity), and never applies a ban to staff (one warning line names only the rule). Every window starts after the last lift of a shadow ban on the account, so a moderator's reversal ends the evidence it judged. A check that fails changes no answer and is logged by its kind with the error's code, never a person; the next event checks again. The check reads its clock after the trigger, so the opener that met a rule stays delivered and the next line is withheld.
3. **The words stay in the chat, in memory.** The chat slice reads the person's openers in one statement through their own participant rows (`openersSince`, `chat/repo.ts`, rule 6) and compares them in `chat/first-messages.ts`, handing the safety slice counts and times only. Nothing derived from a message is stored: no key, hash or length, since a hash of a short opener is reversed with a dictionary. `no-signal.test.ts` holds the statements that read `message` to the chat's repository and the demo's writers.
4. **The rule's record.** Three columns on `sanction` (migration 0064): `rule` (the enum `sanction_rule`), `rule_count` and `rule_first_at`, the earliest event counted. Counts and times only: no message, reporter or conversation. They go with the sanction row, as ADR-024 §8 has it: erasure deletes a shadow ban, open or lifted; the export lists a lifted one as any other, and an open one not at all. The same migration adds `report_reported_created_idx` for the reports window, the index ADR-030 §10 left to #105.
5. **The audit log.** The machine's ban is a `sanction.apply` row with no actor, its detail the sanction's id, kind, reason, rule and count (the maintainer, 19/10/2026). `audit_log.actor_identity_id` becomes nullable, and `audit_log_actor_check` allows a null actor on `sanction.apply` alone. The reader and the panel name the automatic rules as its actor. Every step a person takes afterwards is an audit row as before: Confirm and Reverse are `sanction.review` and a lift from the person's page `sanction.lift`, each naming the rule in its detail; each report closed with the ban is `report.decide`, about the report and naming the sanction (#312), never a person. The migration touches `audit_log`, so its deploy needs `infra/scripts/db-audit-owner.sh <env> release` before and the script again after (ADR-006 §6, `infra/README.md`).
6. **The moderators' list.** `GET /admin/sanctions/automatic`, for moderators and admins, answers the rules' shadow bans that nobody has confirmed, reversed or lifted, oldest first (every one has the same deadline), never one on the reader's own identity: the rule, its count, its first event and when it applied. With the API's clock and `auto_shadow_ban_review_hours` (48), past which one is late. Past the deadline nothing happens: no job lifts it and nothing escalates; the list and the front page's line say Late until a person decides. The front page (`GET /admin/overview`) gains the queue `automatic_bans` and the review hours. The panel's screen is `/automatic-bans`. Confirm and Reverse are #307's `POST /admin/sanctions/{id}/review` with `keep` or `lift`, through #308's confirm step with nothing preset; `own_sanction` never refuses them, since nobody applied the ban.
7. **The reports a ban answers.** #312's rule for which sanction may close a report as acted on (`NAMEABLE`, `safety/report-queue.ts`) now also accepts a sanction applied by nobody that a person kept on review: reviewed, and not lifted at that review's instant. An automatic ban nobody confirmed, or one reversed, closes no report. A confirmed one closes each report filed before it, one by one, each its own `report.decide`.

## Consequences

- An abuser's first hours are stopped without a moderator, and without telling them which rule they met.
- Three verified people can hide somebody until a moderator looks, longer when the review is late. The limits: a bank login per reporter, a proof of contact for every report, distinct identities, dismissed reports not counted, a reversal resetting the evidence.
- False positives fall on ordinary people: a popular greeting to five new matches, many openers after an absence. Their lines arrive at the reversal, under their old times. The moderator judges the message rules by counts and times, never the text.
- A crash between the trigger's commit and the check misses that event until the next one.
- Every opener and every filed report takes the person's sanction lock for a few milliseconds; fine at 5,000 people.
- ADR-031 Open 5's two tells (an archive moving, a gap in the sequence) become more frequent.
- The thresholds are public in this repository; values changed in the panel are not.

## Alternatives considered

- **A nightly job**: misses the first hours, which are the point.
- **The check inside the trigger's transaction**: deadlocks two reports or two sends at the threshold.
- **A table of its own for the rule's record**: more code for three columns' worth of data.
- **Fuzzy similarity**: its own measure and threshold, more false positives on short lines, and harder to judge without seeing the text. The velocity and reports rules are the backstop for a spammer who varies a word.
- **Counting the first reply too**: catches a popular person answering.
- **No audit row for the machine** (ADR-024 §9's default): the maintainer chose the row.

## Open, the maintainer's

1. The reason `other` for every rule; the alternative is `scraping` for the message rules.
2. The person's export after a reversal shows a lifted shadow ban; whether it should say "automatic" is ADR-024's open GDPR Art. 15, Art. 22 and DSA Art. 17 point, with #190 and #188.
3. A moderator who filed a counted report may confirm the ban (ADR-030 Open 17's channel).
4. Keeping the forty-eight hours: a runbook rhythm (#299), or notifications to moderators.
5. An automatic ban stays on the list after an admin bans the identity, until somebody confirms it.
6. #86's view velocity adds its own `sanction_rule` value and reuses the check, the record and the list.

## History

- 2026-10-19: written with #105's build, on the maintainer's parameters of that day.
