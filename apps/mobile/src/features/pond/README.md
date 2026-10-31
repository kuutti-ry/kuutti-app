# pond

Ponds, the public counter and whether matching is open. TD-10, TD-13. #54 (ADR-013): `PondCard` shows what `GET /ponds/counter` says of the person's own pond, in words and never below the threshold, with a line saying that the numbers move in steps of at least k people; `usePondCounter` reads them, `client.ts` is the typed call. #507 (ADR-013 §12 to §16): `SeeksBar` draws whom the people of the pond seek, one bar with a pattern per band and the percentages in words, from the same answer: the read carries the person's session, which is what gives their own pond its bar (§18).

#500 (ADR-060): `GateCard` says one of three things with no number, the profile lacks something, it is finished and the area has not opened, or open, and `useGate` reads `GET /gate`.
