# Tone of the app's text

For everyone who writes or reviews `packages/i18n/messages.yaml`, and sent with every `pnpm i18n:translate` request together with `glossary.yaml`. A starting point written with #13; the maintainers and the native reviewers own it from here.

## Voice

- Plain and warm, the way a considerate person talks. Short sentences. No exclamation marks, no emoji in running text.
- Address the reader directly and informally: Finnish *sinä* (mostly through verb forms, without the pronoun), Swedish *du*. Never the formal plural.
- Calm, not urgent. Nothing in the app hurries anyone: no "don't miss out", no countdowns in words, no streak or score language (CLAUDE.md, Product constraints).
- Say what happened and what the person can do next. Never blame ("you entered an invalid…"); describe ("that date is not valid").
- Rejection-adjacent moments (a pass, no match, the end of a round) are neutral and kind. They never judge the reader or the other person.

## Finnish and Swedish

- Idiomatic over literal. If the English sentence structure sounds translated, restructure it.
- Established Finnish and Swedish words over anglicisms, where an ordinary person would use them on a phone. Technical surfaces (the smoke screen) may keep "API" and "commit".
- Gender-neutral throughout. Finnish is by nature; in Swedish avoid constructions that force *han/hon*.
- Finnish runs about a third longer than English. Buttons and labels stay as short as the language allows; a description in `messages.yaml` says when space is tight.

## Formats (the field sheet's Formats line, #150)

- Dates are d.M.yyyy in every language: 19.9.2026. Never ISO (2026-09-19), never month first (9/19/2026), never a month name on a screen. `formatDate` in `packages/i18n`.
- Times are 24-hour with the language's own separator (14.14); a date with its time is `formatDateTime`, a time alone `formatTime`.
- A height is centimetres with the unit, `formatHeight` (171 cm); an age is a number, said with "verified by your bank"; distances will be bands, never metres, when there is a second pond.
- A date or a number is never built from strings in a client; `pnpm lint` refuses `toLocaleDateString` and `Intl.DateTimeFormat` outside `packages/i18n`.

## Hard rules (checked by `pnpm i18n:check`)

- A dynamic value (`{pond}`, `{name}`) stands only where it needs no inflection: after a colon, as a subject, in a list. Never "in {pond}", never `{pond}ssa`. If the sentence needs a case form, the form comes from the database (`formatPond`), not from the message.
- ICU arguments are kept exactly as in the English source: same names, same plural and select structure, every plural category the language needs.
- Legal texts (`legal.*`: privacy, consent, terms, the police-traceability line) are never machine-translated. The Finnish text is binding and is written by people.
