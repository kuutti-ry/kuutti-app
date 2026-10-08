# ADR-019: Profile fields and their roles

- Status: proposed (the field sheet of 07/10/2026 is the team's decision; the religion list, the hobby list and the draft consent wording are the maintainer's to confirm)
- Date: 2026-10-08
- Follows: TD-14 (age from year and month; the gender model), TD-16 (the profile), ADR-009 (the registry, amended here), ADR-010 §4 (a consent is bound to the version of a wording), ADR-011 (the coarse research snapshot, k ≥ 10), CLAUDE.md rules 3, 5 and 7 and Product constraints (no compatibility score, no desirability signal), `.claude/rules/schema.md` (closed sets, strict contracts), `.claude/rules/i18n.md` (every option a key; legal text never machine-translated); GDPR art. 9; yhdenvertaisuuslaki 1325/2014 s. 8 and s. 11 (the sheet's legal column; not legal advice); issues #145, #146, #147, #148, #149, #150

## Context

Between 1 and 7 October 2026 the team went through what Kuutti asks a person and what each answer may do, field by field, against what Hinge, Tinder, Bumble and Happn ask and what the law allows (the `profile_fields` sheet). The result is a table with two rules per field: the role of the person's own value, and the preference other people may hold about it. ADR-009 §1 made the fields a registry; that registry had nine fields with no roles, and its special-category flag was set on nothing. This ADR replaces the fields and gives every field its two rules, as data, so that the card (#150), the pool and the round builder (#147, #87, #95), the deal-breakers (#149) and the population generator read one table and no field's role lives in a code path.

## Decision

1. **Every field carries two roles, in the registry** (`packages/schema/src/profile-fields.ts`). `role` is what the person's own value may do: `hard` is always in the matching query, both ways; `soft` orders a round and is never shown as a score, nor shown at all; `info` is shown on the card and never queried; `hidden` is stored and never shown (a setting). `preferenceAbout` is what preference other people may hold about it: `hard` always on, both ways; `deal_breaker` an optional hard filter from the whitelist of #149, on a field the person answered themselves, both ways; `soft` ordering only, weight capped; `none` no preference exists. The fields, in the order the screens ask them:

   | field | kind | role | preference about others | note |
   |---|---|---|---|---|
   | intent | long-term / casual / open to either | hard | hard | an onboarding step (#146); "open to either" matches both (#147) |
   | identityLabel | agender, genderfluid, genderqueer, bigender, two-spirit, questioning, just non-binary | info | none | offered after a non-binary gender only, by the screen; never matching |
   | monogamy | monogamous / non-monogamous | info | deal-breaker | |
   | hasKids | no / yes, living with me / yes, not with me | info | deal-breaker | |
   | wantsKids | want / don't want / not sure | info | deal-breaker | the same three answers; the texts adapt to hasKids (want more, no more) on the screens of #148 |
   | smoking | never / sometimes / regularly / quitting | info | deal-breaker | |
   | languages | up to five of a closed list, endonyms | info | deal-breaker | Finnish, Swedish and English pinned; no flags |
   | education | peruskoulu / toinen aste / AMK / kandi / maisteri or YAMK / tohtori | soft | soft, "similar to mine" | AMK and kandi adjacent; never "at least" |
   | drinking | never / rarely / socially / often | soft | soft | |
   | drugsAttitude | not my thing / don't mind / fine with it | soft | soft | an attitude, never behaviour (§4) |
   | hobbies | up to five of a fixed list in twelve groups, plus other | info | none | shared ones highlighted on a card (#150), never a score |
   | height | 140 to 220 cm | info | none | display only, never filterable |
   | exercise | never / sometimes / weekly / daily | info | none | |
   | pets | dog / cat / other / none / allergic | info | none | |
   | field | field of study or work, closed list | info | none | §5 |
   | hideFromField | on or off | hidden | none | "hide me from people in my field", §5 |
   | occupation | a category list | info | none | §5 |
   | occupationTitle | up to 40 characters | info | none | under the plain-text rule; no employer's name |
   | politics | the parliament's parties, none of them, one joke; several | info, shown only when filled | none | article 9, §4 |
   | religion | a closed list | info | none; a deal-breaker only after the Ombudsman's answer | article 9, §4 |
   | zodiac | twelve signs and Corgi | info | none | self-declared: nothing stored could derive it (rule 3) |

   Outside the registry and unchanged in shape: the display name (info), the photos (info), the bio and the prompts (info), the age from the bank's year and month (hard; the age window hard both ways), gender and seek (hard, through seek), the pond (hard). The optional e-mail of #148 is `hidden` and a column on the account, never a field.

2. **The card carries the info fields and the hard ones, never a soft value or a setting.** `CARD_FIELD_KEYS` and `cardFields()` in the registry; the API's card builder (ADR-009 §6) strips the rest for the owner's preview and for anyone else, and the app's card view reads the same keys. A soft value orders a round and is nobody else's to read; a setting is the person's alone. #150 finishes the card's shape and formats.

3. **Every option is a text key**, `profile.option.<field>.<option>`, the field's label `profile.field.<field>`, a hobby group's heading `profile.hobbyGroup.<group>`; English the source, Finnish and Swedish machine text flagged for a native review. Languages are shown by their own name, the same in every catalogue (suomi, svenska, English, русский): a language is not a country, and any flag for one, a special one for Russian most of all, is a statement. Parties by their plain names, no logos. A test in the API holds every field, option and group to a text in all three catalogues, so a missing one fails the build and never reaches a card as its key.

4. **Article 9.** Whom a person seeks, the parties they could vote for and their religion are special categories of personal data (art. 9(1)); Kuutti holds them on explicit consent (art. 9(2)(a)), given on the screen that collects them. One wording covers the three, `legal.special_category.*` in `messages.yaml`, versioned like the other consents (ADR-010 §4), shipped as a draft (`2026-10-draft-1`, English prefixed DRAFT, Finnish prefixed LUONNOS, no Swedish) for the association's counsel to replace. Politics and religion carry the registry's `specialCategory` flag: a value for either is refused with 403 `consent_required` unless the document carries the consent of the current version (`consentMissingFor`, now comparing the version, not only the presence); a consent for any other version is refused with 409 `agreement_outdated`, so no row ever says consent for a text nobody can point at (ADR-009 §2). Seek's consent is onboarding's (#146), under the same wording. The research snapshot (ADR-011) takes closed lists only: never a flagged field, never a text, a number or a setting; gender counts stay under the k ≥ 10 rule. Drugs is asked as an attitude and never as behaviour: use is an offence in Finland, and this answer sits next to a bank-verified identity. Religion stays `none` as a preference until the Ombudsman has answered whether a filter on it holds under yhdenvertaisuuslaki s. 11.

5. **Identifiability in small ponds.** The field of study or work is a closed list of broad fields for now; the sheet's list per university and guild is a configuration of its own, later, and never a filter. The person may hide themselves from their own field: `hideFromField` is a hidden setting, read by the round builder (#95), under which people of the same field never see the person (and so, by the mutual rule, the person never sees them). Occupation is a category plus a short title in the person's words, under the plain-text rule of ADR-009 §3 and with "no employer's name" in the label: free text invites employer names, and a name is an address.

6. **Excluded for good**, and the reason: ethnicity (art. 9 and s. 8; Hinge still filters on it, Grindr removed it in 2020), body type (the appearance rating the design evidence warns against), health or disability (a post-match free text for planning a meeting, visible to the other person only, is the most that will ever exist), social links and the school's name (the killed list of TD-6: external links, identifiability), an orientation label (never derived from seek: a woman seeking women and men may be bi, pan, queer or nothing, and a derived label is an inference of article 9 data with no matching value), personality type, love language, sleeping habits (pseudo-science as data). Later, not now: pronouns, diet (kosher and halal would reveal religion; a generic list if ever), a voice prompt (its own moderation path), the e-mail (#148).

7. **The old fields and their data.** `relationship`, `kids`, `alcohol` and `campus` leave the registry, and `intent`'s options change. By ADR-009 §1 a stored value the registry no longer knows is read as unanswered and its key logged, never the value; no backfill is written, because no person has a profile outside development yet, and the seed, the persona histories and the population generator carry the new registry. The `profile.fields` column stays one `jsonb`; no migration.

8. **Formats** (#150): dates everywhere as d.M.yyyy, the age as a number, the height in centimetres, distances as bands and never kilometres.

## Consequences

- `packages/schema`: the registry with roles, two new kinds (`number`, `flag`), `CARD_FIELD_KEYS`, `DEAL_BREAKER_FIELDS`, `HOBBY_GROUPS`, `POLITICS_OPTIONS`, and tests holding the roles, the contract's keys and the groups to the registry; `RESEARCH_FIELD_KEYS` excludes numbers, settings and flagged fields.
- `apps/api/src/profile`: the consent gate compares the version (`SPECIAL_CATEGORY_CONSENT_VERSION`, built from the catalogue), the card builder strips soft values and settings, the route documents 409, a test holds every text; `PUT /profile` answers 403 for politics or religion without the current consent and 409 for a stale version.
- `packages/i18n`: 222 keys for the fields, the options and the groups; the special-category wording with its version and a golden row in the consent test.
- `packages/db`: the seed profile, the persona histories and the population generator draw from the new registry (`docs/demo/population.md` lists the shares); synthetic people carry the special-category consent when they have an article 9 answer, and the writer stores its version.
- The app's profile screen renders every kind (chips, a number, a text, a switch) and the article 9 fields behind the consent switch; the screens of #148 take the optional fields one at a time with "Ask me later", the adaptive texts and the pickers.
- `pnpm openapi` regenerated the document and the typed client.

## Not decided here

- The deal-breaker whitelist and its cap (#149, `matching_config`); intent as a filter and the gender or seek change rule (#147); the lists per university; the final wording of the special-category consent (the association's counsel); the religion list and the hobby list as shipped (the maintainer's to change; nothing reads their meaning).
