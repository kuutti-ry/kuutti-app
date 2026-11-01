# pond

The public counter and whether matching is open. TD-10, TD-13. #54 (ADR-013): `PondCard` shows what `GET /ponds/counter` says, in words and never below the threshold, with a line saying that the numbers move in steps of at least k people; `usePondCounter` reads them, `client.ts` is the typed call. There is one pond, the country (ADR-061 §8), so nothing here chooses or names one, and no text here says the word (#500): the card's heading is "People on Kuutti". #507 (ADR-013 §12 to §16): `SeeksBar` draws whom those people seek, one bar with a pattern per band and the percentages in words, from the same answer: the read carries the person's session, which is what gives the answer its bar (§18).

#500 (ADR-060): `GateCard` says one of three things with no number, the profile lacks something, it is finished and matching has not opened, or open, and `useGate` reads `GET /gate`.
