# matching

Rounds, filters, likes, budgets, recycling. TD-11, TD-12, TD-14.

#94 (ADR-015): `pool.ts` is who can be shown to whom, `inEachOthersPool`: the hard filters of onboarding in both directions, symmetric by construction. The pond gate counts pools with it and the round builder (#95) draws candidates through it. A block of either side excludes there (#84, ADR-030 §2): each person carries the identities they blocked; deal-breakers join in the same function with #87. `deal-breakers.ts` (#149) stores the deal-breakers as hard rows on the registry's whitelist, each only on a field the person answered themselves, paused while that answer is missing. `savePreferences` calls the pond's `admissionAnew`: whom one seeks decides with whom one waits at the gate (ADR-015 §9).

#96 (ADR-034): `rounds.ts` is today's round: the two tables' statements, `saveRound` (the round builder's one writer, #95), the read through the card builder `app.ts` hands in (`CardOf`), the seen report and the decision (changeable until the Finnish day ends, under the round row's lock), erasure's and the export's halves, and the four research events. Every write asks the block and the candidate's state in the statement that writes (ADR-030 §2). `round-routes.ts` is the app's three routes, the day in the path of each write.
