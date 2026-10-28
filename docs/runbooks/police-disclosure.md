# Requests from the police or another authority

What to do when the police, or another authority, asks Kuutti for data about a person (#189): who takes the request, how it is checked, what Kuutti holds and can find, what it answers, what it never answers, and how each answer is recorded. Kuutti can say very little about a person. It holds no identity code and no name from the bank, and the API writes no client address; whether the proxy on the box does is open (Open, below).

**This page is a draft for the association's counsel. It is not legal advice.** The legal points are marked *(counsel)*. Counsel confirms or corrects them before the first real request, and where counsel and this page disagree, counsel wins. The page follows TD-7, ADR-007, ADR-011 and ADR-024. The person's data stays out of this repository: a request, a name, an account id or an answer never goes into an issue, a pull request, a chat or an LLM (CLAUDE.md, Security and privacy defaults).

Companions: `incident.md` (an answer that went to a forged request is a personal data breach, step 7), `sunset.md` (the records that must outlive the service).

Until production runs (#25), Kuutti holds no real person's data. Staging holds invented people only (ADR-018). A request before then gets that answer.

- Contact: **not named yet** (see Who).
- Counsel's review: **not done yet**.
- Paper test: **not run yet** (see The paper test).

## Who

| role | who | does |
|---|---|---|
| the contact | *the maintainer fills in: name and role in the association* | takes the request, checks the requester, writes the answer and the record |
| the deputy | *the maintainer fills in* | the same, when the contact is away |
| the maintainer | the maintainer | runs the lookups, which need the maintainer's AWS session |
| counsel | *the maintainer fills in* | confirms the legal basis and what may be answered |
| the association's board, through its chair | the chair | the association is the controller: decides whether the person is told (step 10) and approves a tier B answer (step 6), as counsel advises. A proposal: the maintainer confirms |

Requests arrive at *the address the privacy policy gives for authorities; the maintainer fills it in (#190)*. Until the table is filled in, a request goes to the maintainer, who answers nothing before counsel is reached.

Two people see every answer before it leaves: the contact and the maintainer. Neither answers alone. (A proposal: the maintainer confirms.)

## 1. Take the request in writing

- A request is a written document from the authority: an e-mail from its official address, or its own system. A phone call is not a request. Ask the caller to send it in writing, and say nothing about any person, not even whether an account exists. The one exception is an emergency (step 9).
- Write down when it arrived and how. Open the record now (step 8).
- Do not change anything about the person because of a request. No sanction, no pause, no message to them.

## 2. Check who is asking

Before anything is looked up:

1. The request names the authority, the officer, their position, the unit and a case number.
2. The sender's address is on the authority's own domain. Check the domain on the authority's website, not in the message.
3. Call the authority back on a number the contact finds on its website. Never use a number from the request. Ask the switchboard to confirm the officer and the case.
4. Write down the number used, the time and who confirmed.

Stop and write to the authority's official address when:

- the sender uses a personal or free webmail address;
- there is no case number, or the officer cannot be confirmed;
- the request asks for "everything": ask what exactly, and on which provision;
- the request asks only for what Kuutti does not hold, such as an identity code (step 4): say so, once the requester is verified;
- the request comes directly from an authority outside the EU: such requests go through the Finnish authorities (step 3).

An order from an authority of another EU member state on the e-evidence regulation's form (step 3) is not stopped. It goes to the contact and counsel the same day, with its deadline written in the record: it may be eight hours (step 9). It is still verified as above.

## 3. Check the legal basis *(counsel)*

The request names the provision it rests on. Kuutti answers what that provision covers and nothing more. A request without a provision is answered with a request for it.

Where requests are expected to rest, for counsel to confirm:

- **The police:** the Police Act (872/2011), chapter 4, section 3: information a private body holds, needed for a police task, asked by an officer in a commanding position.
- **A coercive measure:** a decision under the Coercive Measures Act (806/2011), such as a seizure or a copy of data, or a court's decision.
- **Another Finnish authority:** the provision of its own act that gives it the right. The same steps apply.
- **An authority of another EU country:** the e-evidence regulation (EU) 2023/1543, which applies from 18 August 2026, lets a judicial authority order data from a service provider in another member state. Whether Kuutti is a service provider in its sense is counsel's first question. The second: whether its companion, Directive (EU) 2023/1544 on designating an addressee for such orders, applies to a provider that serves one member state only. Outside the EU, requests go through the Finnish authorities.
- **The basis under the GDPR:** a legal obligation (Article 6(1)(c)) where a provision obliges Kuutti to answer.

Counsel writes down their view in the record before anything leaves.

## 4. What Kuutti holds

From the schema (`packages/db/src/schema/`). "Erasure" is the person deleting their account (ADR-007, `.claude/rules/db.md`).

| data | where | how long |
|---|---|---|
| The identity: `hetu_hmac`, a keyed hash of the identity code that means nothing without the key (rule 2); the standing (`ok`, `suspended`, `banned`) and its dates; refused logins; the deletion count and the re-registration date | `identity` | survives erasure (TD-7) |
| The latest bank login: Telia's session index, the broker's subject and token id, the time, the level (`acr`) and the method (`amr`, which bank) | `identity.broker_*`, `authenticated_at`, `acr`, `amr` | until the next bank login, in the app or on the panel, overwrites it (`updateBrokerReference`) |
| The account: id, state, registration date, state change date, deletion date, birth year and month, self-declared gender, pond, the optional e-mail | `account` | after erasure a tombstone keeps the id, the state `deleted` and the dates; the age, gender, pond and e-mail are nulled |
| The profile: display name, bio, closed-list fields, prompts; politics and religion under the article 9 consent | `profile` | until erasure; politics and religion also go when the special-category consent is withdrawn (ADR-019 §4) |
| Preferences: whom the person seeks (article 9), the age window, deal-breakers | `preferences` | until erasure; whom the person seeks also goes when the special-category consent is withdrawn (ADR-010 §10) |
| Profile photos: re-encoded variants without metadata, never the original (rule 4); the check's outcome and the automatic description | `photo` (`purpose = profile`), `photo_review`, the media bucket | until the person removes the photo, or erasure |
| Photos sent in a conversation (#350, ADR-031 §10): the same three variants (thumb, card, full) without metadata, never the original; the check's outcome and the automatic description. A photo the check refused was never stored | `photo` (`purpose = message`), `photo_review`, the media bucket | until the sender's erasure: the sender cannot delete one. The erasure takes the rows and the objects (unless another row shares the content), and the message then reads "Photo removed" to the counterpart. Nothing keeps a sent photo past the erasure yet; #351 will keep the ones a report's frozen copy holds (`erasePhotosOfAccount`'s `keep`) |
| Conversations and messages (#348, ADR-031): when each conversation opened, its last message, whether it is archived or closed, how and by which side; its two participants and how far each has read; each message's sequence, side, time, kind and words (a photo's caption is its words). A conversation is the record of a match: the second of two standing likes opens it (#100, ADR-038). In production none is opened until rounds are built there (ADR-035 §7); elsewhere the rounds' decisions, the demo stories and the tests write them | `conversation`, `conversation_participant`, `message` | while one of its two people has an account (ADR-031 §5); nothing goes on an archive or a close. At erasure the person's link goes (`account_id` null) and the messages stay for the counterpart, the person's own among them, except those sent under a shadow ban still open, which go; once both people are erased, the conversation goes with its messages |
| Reports the person filed or received (#84, ADR-030): the reason, the reporter's note if they wrote one, the time, and the moderators' decision with who decided and the sanction it led to; the blocks the person set or received, between the two identities, with the date | `report`, `block` | a report twelve months from filing, swept nightly, whoever of the two is erased; a block as long as the two identities, so it survives erasure |
| What the person fetched and was shown: these rows name other people's photos. A fetch of a photo sent in a conversation has the purpose `message`, written once per viewer, photo and variant in a five-minute window, two reads at the same instant aside | `photo_access`, `card_shown` | until erasure; a `photo_access` row outlives the photo it names |
| Devices: platform, a truncated user agent, when created, last used and revoked; no address | `session` | swept nightly 30 days after sign-out or revocation, or once expired (90 days after the device's last use, and a year after it signed in at most, ADR-058), and at erasure (`apps/api/src/identity/sessions.ts`) |
| Consents, export requests, the place at the pond gate | `consent`, `account_export`, `gate` | until erasure |
| Sanctions, with staff's note | `sanction` | erasure keeps the open bans and suspensions (ADR-024 §8) |
| Feedback the person sent, in their words | `feedback` | until erasure |
| The photo check's notes | `photo_check_note` | twelve months, or erasure |
| Research: the mapping to a random `research_id` while the research consent lasts; events keyed by that id, never by account | `research_subject`, `events` | the mapping until withdrawal or erasure; events 90 days (ADR-011 §6) |
| What staff did or saw about the account | `audit_log` | five years by rule (`.claude/rules/db.md`), survives erasure. Nothing prunes it yet and the table refuses deletes (migration 0006), so rows are kept longer |
| The API's log line per request: account id, request id, method, route, status, duration; never a client address. Every container on the box logs to the same group, Traefik and Dokploy included (`infra/modules/compute/templates/user_data.sh.tpl`) | CloudWatch `/kuutti/prod/api` | 30 days |
| Dokploy's state: `/etc/dokploy` on the box (Traefik's configuration among it) and its nightly copy | the box's disk; the backup bucket under `dokploy-backup/prod/` | the copies 90 days (`infra/bootstrap/main.tf`). Whether they hold an access log is open (below) |
| Login attempts in flight | `auth_request` | ten minutes, swept nightly |
| Database backups, erased rows included | RDS point-in-time recovery (`backup_retention_period = 35`, `infra/modules/data`) | 35 days |

Telia, not Kuutti, keeps the identification logs: five years under section 24 of the Act on Strong Electronic Identification, opened on a police request only (`docs/vendors/telia.md`). The police ask Telia directly.

Sentry receives errors from the API and the app with the request data and the user stripped (`apps/api/src/lib/sentry.ts`, `apps/mobile/src/lib/sentry.ts`). Not storing IP addresses there is an organisation setting (`sentry-setup.md`), which the repository cannot confirm (Open, below). It is not a source for a request.

**Kuutti does not hold:** the identity code; the name from the bank; legal sex; the date of birth (only year and month); a phone number; a location finer than the pond; contacts; payment data. A match is a conversation (above, ADR-038). Likes and passes, a like's fish mark among them (`round_entries.fish`, ADR-039), are the decisions in a person's rounds (#96, ADR-034): whom each person was shown on each day and what they decided, kept until either person's erasure. Reports and blocks (#84), conversations with their messages (#348) and the photos sent in them (#350) do, in the table above.

**Client addresses:** the API writes none to a row or a log line, and holds one in memory for at most two rate-limit windows (ADR-026 §7). Whether the proxy on the box logs addresses is open (below). Until the maintainer has checked, say exactly this, not that Kuutti holds no addresses.

## 5. Find the account

| the requester has | lookup | note |
|---|---|---|
| an account id | `account.id` | the person's own export carries it (ADR-007 §3) |
| Telia's session index of a login to Kuutti | `identity.broker_session_index` | the latest bank login only, in the app or on the panel; a refused login does not replace it. An older login's index finds nothing, which does not mean there was no account (step 7) |
| an e-mail address | `account.email` | optional, and only on a live account: erasure nulls it |
| a photo id | `photo.id` | seen in the app's calls to the API (`/photos/{id}/{variant}`, or a conversation's messages for a photo sent in one) and in the app's cache, not in a media address; while the photo exists |
| a media address (`media/<key>/<variant>.webp`, the path of a signed URL) | `photo.key` | the SHA-256 of the re-encoded picture. The same picture uploaded by two accounts is one key and two rows (`packages/db/src/schema/media.ts`), so it may name several accounts, and only while a row exists. Several accounts: counsel (step 6) |
| an identity code | none | Kuutti has no tool to search by identity code and keeps only the keyed hash (rule 1). Computing the hash of a given code is possible with the key, which rule 2 keeps in SSM with one offline backup. Building that is an identity change that needs an ADR, and a court's order for it is counsel's question (step 6). The police can ask Telia for the person's identification events at Kuutti; whether Telia answers with the session index is not confirmed yet (`docs/vendors/telia.md`) |
| a name, a display name, an age, an area, a screenshot | none | not identifiers. Display names are not unique, and the panel has no search by design (`.claude/rules/admin.md`). A stored photo is a re-encoded file, so a screenshot matches nothing. Ask for one of the identifiers above |
| a phone number, an IP address, a device id | none | not held; for addresses, say only what step 4 allows |

The maintainer looks up, from their own machine, never in a shell on the box: a shell session streams what is typed to `/kuutti/ssm-sessions` (`infra/README.md`). Sign in first: `pnpm aws:login`. The port forward is the one `infra/scripts/db-app-role.sh` opens:

```sh
cd infra/envs/prod && tofu init
aws ssm start-session --target "$(tofu output -raw instance_id)" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$(tofu output -raw db_host),portNumber=5432,localPortNumber=15432"
```

In a second shell, from the repository root. The password stays inside the shell, and `PSQL_HISTORY=/dev/null` keeps the identifier out of psql's history file:

```sh
PGPASSWORD="$(aws ssm get-parameter --name /kuutti/prod/db-app-password --with-decryption --query Parameter.Value --output text)" \
PSQL_HISTORY=/dev/null \
psql "host=$(cd infra/envs/prod && tofu output -raw db_host) hostaddr=127.0.0.1 port=15432 dbname=kuutti user=kuutti_app sslmode=verify-full sslrootcert=apps/api/certs/rds-eu-central-1-bundle.pem"
```

There is no read-only database role yet. The transaction is read-only instead. Postgres logs a failed statement with its text (`infra/scripts/db-app-role.sh`), so a typo puts the identifier in the database's log: read each query before running it. Use the one query that fits the identifier.

The identity row survives erasure (TD-7), so it leads to every account the person has had. The session-index query returns only the account that was live at that login. The account-id query gives the latest login's time and index only when that login fell in this account's life, never a later account's. Linking accounts across an erasure is counsel's question (step 6).

```sql
BEGIN READ ONLY;
-- by Telia's session index: the account live at that login, a tombstone if erased since
SELECT a.id AS account_id, a.state, a.registered_at, a.deleted_at, i.authenticated_at
FROM identity i JOIN account a ON a.identity_id = i.id
WHERE i.broker_session_index = '<session index>'
  AND (a.deleted_at IS NULL OR a.deleted_at > i.authenticated_at);
-- by e-mail
SELECT id, state, registered_at, deleted_at FROM account WHERE lower(email) = lower('<address>');
-- by account id
SELECT a.id, a.state, a.registered_at, a.deleted_at,
       CASE WHEN a.deleted_at IS NULL OR a.deleted_at > i.authenticated_at
            THEN i.authenticated_at END AS latest_bank_login,
       CASE WHEN a.deleted_at IS NULL OR a.deleted_at > i.authenticated_at
            THEN i.broker_session_index END AS session_index
FROM account a JOIN identity i ON i.id = a.identity_id
WHERE a.id = '<account id>';
-- by photo id
SELECT account_id FROM photo WHERE id = '<photo id>';
-- by media address: the key is the path segment after media/
SELECT account_id FROM photo WHERE key = '<key>';
ROLLBACK;
```

Then put the look on record in the panel (`admin.kuutti.app` comes with #25). As an admin, open the audit viewer (`/audit`) and narrow it to subject type `account` and the account id. That writes an `audit.read` row about the account (`.claude/rules/admin.md`) and shows only what staff did or saw about it. Do not open the person's page (`/accounts/<account id>`) for a tier A answer: it shows the age, the gender, the pond, the profile as the card shows it, the photo list, the feedback texts, the latest 50 audit rows and the sanctions with staff's notes (`apps/api/src/safety/accounts.ts`). Open it only when a tier B answer needs it; that writes `account.view`, and a photo is fetched only on a click (`photo.view`).

Write each lookup in the record: the identifier, the query, the time, the result.

## 6. What may be answered *(counsel)*

| tier | what | when |
|---|---|---|
| A | Whether an account exists for the identifier, and whether it is deleted. Its id, its registration date (an erased account's only if counsel allows, below) and its deletion date. The latest bank login's time and Telia's session index, when that login fell in this account's life, so Telia can map it to the person | a verified request (step 2) with a provision that covers it (step 3) |
| B | Content and activity: the profile, the profile photos, the devices, the fetch log, the feedback text, the sanctions and staff's note (a note may name a reporter), the account's other states (paused, shadow-banned, suspended, banned) and their dates, the identity's standing, whom the person seeks, politics and religion (article 9), the method of the bank login, the API's log lines about the account | never without a court's decision or a decision under the Coercive Measures Act that names it (the proposed line, for counsel); the board approves (Who) |
| – | Conversations, their messages and the photos sent in them (#348, #350); the frozen copy of a conversation a report names (#351) | open: whether any of it may be answered, in which tier and on which decision, is for counsel and the maintainer to settle (Open, below). The frozen copy does not exist yet; #189 lists it as answerable. Whether messages fall under the confidentiality of communications, and so need a court, is counsel's question, open now that messages exist |
| C | Never: the identity code (not held); `hetu_hmac` and the key; the birth year and month, which come from the identity code (that every account was 18 or older at registration may be said); research events and the `research_id` of a person (rule 5, ADR-011 §9); anyone else's data; a bulk answer or an "everyone who" search; a backup restored, a new log started or an account watched for the requester | if a court orders any of these, counsel and the maintainer decide together. This page does not |

Answer only what was asked, even when more is found.

Questions for counsel on the tiers:

- **The state and the standing.** The raw state shows a shadow ban, which the person's own export reads as `active` (ADR-007, History 2026-10-16), and a suspension or ban; the standing comes from open sanctions (ADR-024). The proposal puts them in B with the sanctions, and A says only whether the account is deleted. Or does A give the raw state?
- **Links across an erasure.** The identity, and so the session index and the latest login, outlive every account the person has had. The panel withholds that link, and an erased account's registration date with it (#306, `apps/api/src/safety/accounts.ts`); #189 puts anything derived from the identity code among what is never answered. May an answer link accounts across an erasure, or give a tombstone's registration date? Until counsel answers, an answer names only the account the identifier points to (for a session index, the one live at that login), and gives an erased account's deletion date, not its registration date. Even that departs from the panel's rule of #306, which shows of an erased account its deletion date and nothing tied to the identity: the record says so.
- **A media address that names several accounts** (step 5): whether all are answered, or none without a narrower request.
- **A court order to search by identity code** (step 5): whether Kuutti must build the computation, and under which safeguards.

## 7. Answer

1. The contact drafts the answer: the identifier searched, the time of the search, and one of three forms. Plain facts, no interpretation.
   - The tier A facts.
   - For an account id that matches nothing: "No account with this id exists or existed at Kuutti." An erased account keeps its id as a tombstone (ADR-007), so this holds.
   - For any other identifier that matches nothing: "This identifier matches nothing Kuutti holds. Kuutti keeps only the latest bank login's session index, an e-mail only on a live account and a photo only while it exists, so no match does not mean that no account existed." Never a bare "no account".
2. The maintainer reads it against the request and the record.
3. It goes to the verified official address, as a reply to the request. Tier B data goes by the channel the authority uses for evidence, agreed with them, never as an attachment to an ordinary e-mail.
4. A copy goes into the record.

If a request is found forged after an answer left, the answer is a personal data breach from that moment: follow `incident.md`, whose 72 hours start then, and note it in the record.

## 8. The record

The database has no disclosure record yet. `AUDIT_ACTIONS` in `apps/api/src/safety/audit.ts` has no disclosure action. The security checklist says disclosure requests join the audit table later, and #106 names this issue as the disclosure record. Until it exists, the record is a document the contact keeps in a place only the contact, the maintainer and counsel can open. That place belongs to the association, not to a personal account (TD-4). It is never in this repository. Where it is: *the maintainer fills in*.

One record per request:

```text
Received:          date, time, channel
Authority:         name, unit
Officer:           name, position
Case number:
Provision cited:
Asked for:
Deadline:
Confidentiality:   asked or not; until when; on which provision
Verification:      domain checked; number called, where it was found; time; who confirmed
Counsel's view:    date; what may be answered
Lookups:           identifier, query, time, result (one line each)
Audit row:         time of the audit.read row (the audit viewer narrowed to the account);
                   of the account.view row too, if the person's page was opened, and why
Answered:          date, time, channel; tier A or B; what was sent
Answered by:       the contact and the maintainer
Person told:       no / yes, date, how
Keep until:        date
```

Keep each record five years, the period the audit log's rows have by rule (`.claude/rules/db.md`; nothing prunes the audit log yet, so its rows stay longer). This period is a proposal for counsel.

## 9. Timelines

- **Acknowledge** the request the next working day. This is a proposal: the maintainer sets the target.
- **Answer** by the requester's deadline. If it cannot be met, for example because counsel has not answered, say so in writing before it passes.
- **Emergency** (the requester says a life or health is in immediate danger): the contact calls the maintainer at once. The officer is checked by calling the authority's switchboard back (step 2). Tier A may then be answered at once, and the written request follows and goes into the record the same day. This path is a proposal for counsel (GDPR Article 6(1)(d), vital interests).
- **E-evidence orders** from another member state carry their own deadlines in regulation (EU) 2023/1543: ten days, or eight hours in an emergency *(counsel: whether it applies)*.

What expires, and when. A request about an older event may find nothing:

| what | gone |
|---|---|
| a login attempt | ten minutes, swept nightly |
| the latest bank login's session index | at the next bank login |
| a device (`session`), and so when it was last used | 30 days after sign-out or revocation, once expired (90 days after its last use, a year after it signed in at most), or at erasure |
| whom the person seeks, politics and religion | when the special-category consent is withdrawn, or at erasure |
| the box's container logs, the API's included | 30 days |
| Dokploy's nightly backups | 90 days |
| an erased account's rows | at once (ADR-007 §1), except what step 4 keeps past an erasure; in the database's backups for 35 days |
| a photo sent in a conversation | at the sender's erasure; the message then reads "Photo removed" |
| a conversation and its messages | when the second of its two people is erased; messages sent under a shadow ban still open, at the sender's erasure |
| a report | twelve months from filing, swept nightly |
| research events | 90 days, and never answered by person |
| the photo check's notes | twelve months |
| the audit log | five years by rule; no prune exists yet, so kept longer |
| Telia's identification logs | five years, at Telia |

Kuutti has no legal hold. If the person deletes their account while a request is open, the data goes (ADR-007). A request to preserve data goes to counsel. Never improvise a hold by editing rows.

## 10. Telling the person

- By default, the person is not told while the request asks for confidentiality, or while counsel has not answered.
- The person's export (ADR-007) lists no disclosures and no audit rows. If the person asks who received their data (GDPR Article 15), counsel answers. A restriction needs a basis in law, which counsel names *(counsel)*.
- When the confidentiality ends, the board decides, on counsel's advice, whether the person is told. The record says what was decided.
- Never through the app, a sanction or a change to the account.

## Open, for the maintainer and counsel

- Name the contact, the deputy and counsel, and the address requests arrive at (Who).
- The privacy policy names this procedure (#189, step 3): the police-traceability line under `legal.*`, written by people and never machine-translated (`.claude/rules/i18n.md`), with the final policy (#190). It is not in `messages.yaml` yet.
- Where the record lives, and how long it is kept.
- The tiers of step 6, the provisions of step 3, the emergency path, and whether the e-evidence regulation applies.
- The disclosure record in the database: an action in `AUDIT_ACTIONS` or a table of its own, with #106. A retention change, so an ADR.
- Preservation: no legal hold exists. Whether one is needed is a data-retention decision, so an ADR.
- Lookup by identity code: no tool exists, on purpose. Computing the hash of a given code with the key is possible; building that is an identity decision, so an ADR.
- Kuutti keeps the latest bank login's reference only. A history of them would be a retention change, so an ADR.
- Telia: whether its logs answer by session index (`docs/vendors/telia.md`), to ask again when the agreement is signed.
- Whether the box keeps client addresses: Traefik's access log, if it is on, in the CloudWatch group `/kuutti/prod/api` (every container logs there), on the box's disk under `/etc/dokploy`, and in the nightly Dokploy backups kept 90 days under `dokploy-backup/prod/` (`infra/modules/compute/templates/user_data.sh.tpl`, `infra/bootstrap/main.tf`). It is Dokploy's configuration, outside this repository; the maintainer checks once, and with it that Sentry's organisation setting "Prevent storing of IP addresses" is on (`sentry-setup.md`). CloudFront has no access logging in `infra/`. Until then, step 4's line on client addresses is what may be said.
- Whether a backup may be restored to answer about an erased account.
- Conversations, their messages and the photos sent in them (#348, #350): whether any of it may be answered, in which tier, and whether the confidentiality of communications asks a court's decision for it (step 6).

## The paper test

Once before the beta, and again after a large change to this page. The maintainer handles the requests. A second person plays the requester, keeps time and writes down where the page was silent, wrong or slow. Nothing touches staging or production. About an hour.

Before: the second person prepares the three rounds below on paper, without showing them to the maintainer. Print this page. Have a clock.

**Round 1: the call.** Target: the right refusal within 5 minutes.

The second person phones: "Detective sergeant Example, police. We need the name and the identity code of the Kuutti user 'Mikko, 34, Helsinki' today. It's urgent."

Expected: nothing about any person, not even whether one exists. Ask for the request in writing at the official channel. Open a record with the call. No emergency was claimed, so no emergency path.

**Round 2: the e-mail.** Target: the decision within 15 minutes.

An e-mail from a free webmail address, signed "Crime inspector Example", with a case number and no provision. It asks for "all messages, photos, IP addresses and the identity code" of the account with a given e-mail address, within 24 hours.

Expected: verification fails on the domain (step 2). The maintainer finds the switchboard on the authority's website and asks for the request from an official address, naming its provision. Nothing is looked up yet. Once verified, the answer says what Kuutti does not hold (identity codes), says of addresses only what step 4 allows (the API writes none; the proxy's log is open until the maintainer has checked), and profile photos are tier B: counsel. Messages and the photos sent in them are held; whether any may be answered is open for counsel and the maintainer (step 6).

**Round 3: the real one.** Target: a drafted answer within 30 minutes, counsel's step played by the second person.

From the official address, signed by an officer in a commanding position, a case number, the Police Act chapter 4 section 3 cited. It asks whether an account belongs to a given Telia session index, when it was registered and when it was last used. It asks for confidentiality for three months. Then the second person adds: the account was deleted yesterday.

Expected: the lookup by session index (step 5) finds a tombstone: the account was erased after that login. (Had the index been an older login's, it would find nothing, and the answer is step 7's third form, never a bare "no account".) The answer gives that an account existed and is deleted, the deletion date and the latest bank login's time. The registration date of an erased account waits for counsel (step 6), and the state before the deletion and the standing are tier B. "Last used": the devices went with the erasure, and the API's log lines are tier B. The backups are counsel's call. The record is filled, confidentiality noted with its end date, and the person is not told.

**Debrief, 10 minutes.** For each round: the time taken, what the page did not say, what it said wrongly. Fix the page in a pull request and add a line to the log below.

**Optional desk check, locally only.** Run the queries of step 5 against the local database, `psql postgres://kuutti:kuutti@127.0.0.1:5432/kuutti` (the default of `env.example`), never staging's or production's, so a typo in this page shows. With `pnpm env:up` and `pnpm demo:reset` (not while other work uses the local stack), Tapio is banned in his story, so his account is the one with an open ban: `SELECT account_id FROM sanction WHERE kind = 'ban' AND lifted_at IS NULL`. Use it for the account id query. Then open `http://localhost:5173/audit`, narrow it to subject type `account` and that id, and see the `audit.read` row it wrote. The audit viewer is an admin's: `docs/demo/runbook.md` grants the local persona `moderator`, and the same command grants `admin`. The mock bank's personas send no session index (`services/mock-idp/login.html`), so that query finds nothing locally.

### Log

| date | who (roles) | duration | gaps found | fixed in |
|---|---|---|---|---|
| not run yet | | | | |
