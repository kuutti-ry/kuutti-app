# pond

Ponds, the admission gate, the public counter. TD-10, TD-13. #54 (ADR-013): `WaitlistCard` shows what the public `GET /waitlist` says of the person's own pond, in words and never below the threshold, with a line saying that the numbers move in steps of at least k people; `useWaitlist` reads them, `client.ts` is the typed call. #507 (ADR-013 §12 to §15): `SeeksBar` draws whom the people of the pond seek, one bar with a pattern per band and the percentages in words, from `usePondSeeks`, which reads the signed-in `GET /ponds/seeks`; a read that fails leaves the bar out.
