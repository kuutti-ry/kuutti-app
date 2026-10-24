# matching

Rounds, filters, likes, budgets, recycling. TD-11, TD-12, TD-14.

Today's round (#379, ADR-034): `RoundScreen`, `useRound`, the round's client. The short pool (#99, ADR-042): at the end of a short or empty round `ShortPool` reads what may be relaxed for today and offers each as a button with how much it widens the pool; a tap appends the cards it added (`useRound`'s `relax`), and a relaxed card names its deal-breaker and undoes it in one tap (`unrelax`). Every card names the person's deal-breakers its person did not answer.

Flows, from the person's side (#395): [The round, likes, fish and the match](../../../../../docs/flows/round.md), [The waitlist and the pond's gate](../../../../../docs/flows/waitlist-and-gate.md).
