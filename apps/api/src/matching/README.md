# matching

Rounds, filters, likes, budgets, recycling. TD-11, TD-12, TD-14.

#94 (ADR-015): `pool.ts` is who can be shown to whom, `inEachOthersPool`: the hard filters of onboarding in both directions, symmetric by construction. The pond gate counts pools with it and the round builder (#95) draws candidates through it; blocks and deal-breakers join in the same function with #87. `deal-breakers.ts` (#149) stores the deal-breakers as hard rows on the registry's whitelist, each only on a field the person answered themselves, paused while that answer is missing. `savePreferences` calls the pond's `admissionAnew`: whom one seeks decides with whom one waits at the gate (ADR-015 §9).
