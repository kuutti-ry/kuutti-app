# @kuutti/i18n

`messages.yaml` is the source of truth for every user-facing string in app, API and admin (#13, TD-17). Rules: `.claude/rules/i18n.md`. Tone and vocabulary: `docs/i18n/tone.md`, `glossary.yaml`.

## Adding or changing text

1. Add a semantic key to `messages.yaml` with `en` and a `description` that tells a translator where the text shows and how much room it has. ICU MessageFormat for arguments and plurals.
2. Finnish is required (`fi`), Swedish warns (`sv`). Run `pnpm i18n:translate`, which fills what is missing and flags it `machine: { fi: true }`, or write the text yourself with the same flag: every fi and sv text carries `machine:` until a native reviewer approves it (next section). `admin.*` keys are English only. `legal.*` keys take a `consent_version`, are never sent to the translator and never carry a flag or a review hash. Where the room is fixed (a button in a row), `max_length: <characters>` holds every language to it.
3. `pnpm i18n:build`, and commit `src/generated/` with the YAML. CI fails when they drift, like the OpenAPI types (ADR-003).
4. Use it: `t("profile.bio.required")`, `t("errors.rate_limited", { seconds })`. An unknown key, a missing argument or a wrong argument type does not compile.

Never inflect a dynamic value: `in {pond}` and `{pond}ssa` fail the check. A pond's case form comes from the database through `formatPond(pond, "inessive", locale)`.

## The native review (#55)

A native reviewer reads machine text and approves it; `docs/i18n/translation-review-guide.md` is their guide. An approval replaces the flag with `reviewed: { fi: "<hash>" }`, a hash of the English and the approved text, so a later edit to either fails CI as "changed since its native review" until someone flags it again.

| command | does |
|---|---|
| `pnpm i18n:review` | progress per namespace: reviewed, machine, stale |
| `pnpm i18n:review --list [--stale] [--prefix onboarding.]` | the texts waiting, with their English |
| `pnpm i18n:review --export tsv --locale fi --prefix photos. --out photos-fi.tsv` | the review sheet for a spreadsheet (`--export md` for a table to read; `--all` includes reviewed texts) |
| `pnpm i18n:review --import photos-fi.tsv --locale fi [--dry-run]` | applies the returned sheet: approved rows get the hash, corrected rows without approval stay machine text, rows changed in the repository since the export are refused |
| `pnpm i18n:review --approve --locale fi onboarding.gender.title 'onboarding.welcome.*' [--dry-run]` | approves texts a reviewer accepted as they are, for instance through suggestions on a pull request |
| `pnpm i18n:review --reflag --locale fi <keys> \| --stale` | puts a changed text back to machine text |

`--approve` and `--import` record a native reviewer's decision: a developer runs them on the reviewer's word, in the pull request the reviewer approves, and an agent never does. `--reflag` only asks for more review, so anyone may run it. The reviewer's approval on the pull request is the record of who reviewed; nothing about the reviewer is stored in the file. The ruleset dismisses an approval when new commits arrive, so the reviewer approves after the `--approve` or `--import` commit, and CI puts a warning on the line of every text a pull request newly approves (or whose reviewed wording moved), so the approver sees exactly what they approve. The job summary shows the progress.

## What is where

| path | what |
|---|---|
| `messages.yaml`, `glossary.yaml` | the text and the product vocabulary |
| `src/generated/` | one catalogue per locale, the `en-XA` pseudo-locale, and `MessageKey` / `MessageParams`; generated, committed |
| `src/index.ts` | `createI18n`, `typedT`, `resolveLocale`, `parseAcceptLanguage`, `formatDate`, `formatNumber`, `formatPond` |
| `src/react.tsx` (`@kuutti/i18n/react`) | `createReactI18n`, `I18nProvider`, `useT` for app and admin; the API never imports it |
| `src/pseudo.ts` (`@kuutti/i18n/pseudo`) | the `en-XA` catalogue, a separate entry so only a dev build bundles it |
| `scripts/` | `build`, `check` (`--release`), `check:ui-strings` (part of `pnpm lint`), `translate`, `review` |

## Runtimes

- **App**: `src/lib/locale.tsx` resolves the phone's languages (`expo-localization`) to a catalogue, lets a stored in-app choice beat it, and offers `en-XA` in dev builds. Locales fall back to English per key.
- **API**: `src/lib/i18n.ts` gives each request `c.get("t")` and `c.get("locale")` from `Accept-Language` (the account's stored locale from M2). Error envelopes keep their stable `code`; the `message` follows the request's language.
- **Admin**: English only by decision; it still reads its text from here.

## Checks

`pnpm i18n:check` (CI job `i18n`): the file validates, every key has `fi` (fail) and `sv` (warn), every locale is valid ICU with the source's arguments, every plural form its language needs (CLDR) and the English's exact cases and select options, no dynamic value is inflected, `max_length` holds, and every fi and sv text is machine text or carries a review that still matches it. `--release` (a `v*` tag, a production EAS build) also fails on machine text in a released language (`RELEASED_LOCALES`: en and fi) and on draft legal text. `pnpm lint` fails on a user-facing string literal in the clients' TSX.

`pnpm i18n:translate` sends message text (with approved translations from the same namespace as examples), the glossary and the tone guide to the Claude API (`claude-opus-5`), and nothing else; credentials come from the developer's environment (`ANTHROPIC_API_KEY` or an `ant auth login` profile) and are never committed. Every answer is validated and written as machine text.

| command | does |
|---|---|
| `pnpm i18n:translate` | texts that do not exist yet, in fi and sv (`--locale fi` for one) |
| `--prefix onboarding.`, `--keys a,b` | narrows the selection |
| `--retranslate --prefix p.` | writes machine text again, never reviewed text; needs `--prefix` or `--keys`, since a reviewer may be reading the rest |
| `--stale` | writes again, as machine text, reviewed texts whose English or translation changed |
| `--dry-run` | the requests it would send, with their keys and the number of examples; sends nothing |
| `--compare --prefix p.` | sends the requests for machine text (or `--stale`) and prints the current and the new text side by side, with the reason a new text would be refused; writes nothing; needs `--prefix` or `--keys` |
| `--chunk-size 40` | keys per request, one namespace at a time |
| `--mode batch`, then `--batch-id <id>` | one Message Batch for every request, at half the price, results within 24 hours; the second command collects them on the same machine (what each request asked for waits in the gitignored `packages/i18n/.batches/`) |

Sync requests ask for the server-side fallback (`fallbacks: "default"`), so a request the model's classifiers decline is answered by the recommended fallback model; the Batches API has no fallback. Only the keys a request asked for are kept from its answer. A request that still fails costs its keys, not the run. Each request's token use is printed; the tone guide and glossary carry a cache breakpoint, and `cache read` shows whether later requests used it.
