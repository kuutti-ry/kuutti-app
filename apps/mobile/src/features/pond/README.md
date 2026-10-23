# pond

Ponds, the admission gate, the public counter. TD-10, TD-13. #54 (ADR-013): `WaitlistCard` shows what the public `GET /waitlist` says of the person's own pond, in words and never below the threshold, with a line saying that the numbers move in steps of at least k people; `useWaitlist` reads them, `client.ts` is the typed call.

Flows, from the person's side (#395): [The waitlist and the pond's gate](../../../../../docs/flows/waitlist-and-gate.md), [Onboarding](../../../../../docs/flows/onboarding.md).
