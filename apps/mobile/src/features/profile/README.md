# profile

Onboarding, profile fields and prompts, completeness. TD-16. The photo tips are the media slice's since #287.

What others see is the person's choice, field by field (#515, ADR-019 §2): a card shows every answer until `FieldEditor`'s title row says Hide. The set saves with the rest of the screen, merged key by key like the answers (`useProfile`). It changes the card and nothing else.

The home (#514, ADR-061) is no field of the registry and no part of the draft: `PlaceEditor` holds the postal code with its autocomplete, read from `@kuutti/schema/postal-areas` on the phone, and what the card will say; onboarding's two home steps and `PlaceScreen` stand on those, and `saveHome` writes through its own route. The digits stay in `PlacePicker`'s state until a row is tapped, go in that one body, and leave with the save. `useProfile` reads the home's names and never holds them in what it sends. A card says a name, and a round's card the band its entry froze, handed in by `RoundScreen`.
