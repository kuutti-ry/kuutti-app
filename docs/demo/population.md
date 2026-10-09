# The synthetic population

Data dictionary of `pnpm demo:population` (#73, ADR-014 §8 to §10). The population is never stored: `generatePopulation` in `packages/db/src/seed/population.ts` makes it from a seed, a size and an epoch, and the numbers below are what it makes at the defaults (size 300, seed 73, epoch 01/09/2026, which is in the past so that nobody registered in the future). Change a number there and here in the same change; the tests hold the thresholds.

## Commands

```bash
pnpm demo:population
```

Writes three hundred people into the database of the local environment, replacing the synthetic population that was there. The pond comes from the seed, which `pnpm env:up` has run.

After a write or a removal the public counter (#54) is counted anew over what is in the database now, so `GET /waitlist` and the card in the app show the ponds of the population at once. Left to itself the counter would not move: it counts once a day and moves in steps of ten people, which is right among people and would leave a demo showing yesterday's ponds. What may be said of a pond is decided as ever; the app keeps an answer for up to an hour.

| option | what it does |
|---|---|
| `-- --size 5000` | as many people as asked, 1 to 5,000. From 235 people up the population shows everything it is there for; a smaller one is written too, and the command says what it does not show (`notShown`) |
| `-- --seed 7` | other people in the same ponds |
| `-- --dry-run` | prints the counts per pond and writes nothing; it does not connect |
| `-- --remove` | removes the synthetic population and writes nobody |
| `-- --env preview` | for a pull request's own database, `kuutti_pr_<n>` |
| `--env staging` | on staging, from inside the API's container only (`--remove` there reports the personas' rows as `spared`: they carry the mark but not a label's hash, ADR-014 §9, and the reset is what forgets them): `node dist/demo-population.js --env staging` (ADR-018; `infra/README.md` says how to reach the container). The database is read from staging's own parameter store, never given |

## Where it refuses to write

Three hundred accounts that look bank-verified, among real people, would enter the public counter, count toward the gate and appear on people's cards. So:

- it goes ahead only when the environment is `development`, `test` or `preview`, by `--env` and by `APP_ENV`, both when both are given;
- it refuses an argument it does not know, so a mistyped `--dryrun` is not a write, and an argument given twice, so `--env production --env development` does not talk its own first word away;
- after connecting and before writing or removing anything it prints where it is connected (database, user, host, port; never a password) and asks the server what it is. A managed server (RDS) is refused unless the database is a pull request's own and the environment is `preview`, or the environment is `staging` and the command runs inside staging's container. Staging and production are reached through a tunnel on 127.0.0.1 under the same database name as the local one, so neither the host nor the name tells them apart, and neither does the server: what does, for staging, is that the command was given nothing by hand (`APP_ENV` is staging, and no `DATABASE_URL`, no key, no parameter prefix in its environment), so its database can only be the one staging's own parameter store names (ADR-018 §3).

## Who lives where, and why

One country-wide pond for now (#146, ADR-010 §10): everybody who onboarded is in Suomi, and the pond has to show everything at once.

| pond | people | women | men | non-binary | why |
|---|---|---|---|---|---|
| Suomi | 276 | 88 | 171 | 17 | over `gate_k` (30); men are 62 %, over `majority_share_max` (0.6), so the admission rule holds them back; every cell at ten or more, so the counter shows the split |
| none | 24 | | | | registered at the bank and gone before the first onboarding step: no gender, no pond, no consent |

These are exact counts, apportioned from shares by largest remainder, not draws: the thresholds are crossed by construction, from a population of 174 up (a test goes through every size; below that the non-binary cell is under the counter's k, and under 33 people the pond is under the gate). At another size 8 % never onboarded and the rest is in Suomi with the same gender shares.

Everybody with a pond has a gender, because the app asks for the gender before the pond is assigned.

## What is drawn

| what | how |
|---|---|
| age at the epoch | 18 to 22: 14 %, 23 to 27: 30 %, 28 to 32: 24 %, 33 to 39: 16 %, 40 to 49: 10 %, 50 to 64: 5 %, 65 to 80: 1 %. Stored as year and month of birth, moved so that the product's own age rule (TD-14) gives the age drawn |
| registered | up to 60 days before the epoch, and at least ten minutes before it, so that the consents, given within nine minutes of registering, are before the epoch too |
| language | Finnish 70 %, Swedish 8 %, English 22 %: the language the consents were shown in and the profile is written in |
| seeks | by own gender. Women: men 78 %, women 8 %, several 14 %. Men: women 82 %, men 7 %, several 11 %. Non-binary people: all three 50 %, two of them 40 %, non-binary only 10 % |
| age window | from 2 to 8 years under the person's age (never under 18) to 2 to 10 years over it (never over 99) |
| consents | terms, privacy and the special-category consent of the seek screen for everybody who onboarded (#146); the profile's own record of that consent, the one politics and religion need (ADR-019 §4), for 35 % of those with a profile, given with the others. No research consent: the product writes it together with its mapping row, synthetic people emit no events, and theirs would muddy the first real numbers |
| profile | 88 % of those who onboarded have one |
| display name | a given name from the list of the person's gender; the lists hold names with å, ä and ö and one in another script (Юлия) |
| bio | a bio 65 % (a few of the bios are too short to count for completeness, on purpose), a canned line 12 %, nothing 23 % |
| prompts | none 25 %, one 20 %, two 35 %, three 20 % |
| fields | the registry of `packages/schema` (ADR-019), options straight from it. Everybody with a profile has an intent (an onboarding step, #146): long-term 55 %, casual 20 %, open to either 25 %. Then, of those with a profile: monogamy 50 % (monogamous 85 %), kids 60 % (none 70 %, living with me 18 %, not with me 12 %), kids in the future 55 %, smoking 65 % (never 60 %, sometimes 20 %, regularly 12 %, quitting 8 %), languages 85 % (the person's own and up to two more), education 65 %, drinking 65 % (never 15 %, rarely 30 %, socially 45 %, often 10 %), attitude to drugs 40 %, one to five hobbies 70 %, a height of 152 to 198 cm 55 %, exercise 55 %, pets 50 % (none 35 %, a dog 25 %, a cat 25 %, both 8 %, other 4 %, allergic 3 %), a field of study or work 45 % (and 15 % of those hide themselves from their field), a line of work 50 %, a job title 30 % (titles only: no employer is named), a star sign 45 %. Politics (one to three parties, 70 %) and religion (60 %) only among the 35 % who gave the special-category consent, as the API would have it |

Nobody has a photo until the photo loader of #73's later part, so nobody in the population has a complete profile yet.

## What makes a synthetic person unmistakable

- The label, `demo-0001` onwards.
- `identity.hetu_hmac` is the SHA-256 of the label, not an HMAC of a code: no bank login maps to it.
- `identity.broker_subject` starts with `kuutti-demo:` and no time of authentication is stored.
- The removal needs all of it: the mark, the hash of the label behind the mark, and no authentication. The mark alone is not enough, because it sits where a login stores what the broker called the person; an identity that carries the mark and is not synthetic is left alone and counted as `spared`.

## The words

`packages/db/src/seed/words.ts`: given names, job titles, bios and answers to the twelve prompts, in Finnish, Swedish and English. Every line was written for that file; nothing is copied from a profile, a person or a site. A test in the API runs every line through the plain-text rule of the profile, so a line with something that reads like an address, a number or a handle fails the build.
