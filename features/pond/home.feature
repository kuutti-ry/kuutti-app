# features/pond/home.feature
Feature: The home
  Everybody has one home, whoever commutes, and it alone says where a person
  is (#514, ADR-061; the maintainer, 31/10/2026). Onboarding asks for it after
  the age window, as the five digits of a postal code, which are looked up in
  memory in Statistics Finland's list. What is kept is a place of at least
  home_min_inhabitants people (3,000): the postal area, else its municipality,
  else the nearest municipality that has them; and an area keeps its own key
  only while enough people are left behind its municipality's. This is the one
  number of the design: no name on a card, no band, no probing and no leak
  narrows anybody below it. A card says a name and never digits: the nearest
  town of at least home_town_min_inhabitants people (20,000), or the area where
  an area is kept and the person asks for it. The home changes whenever the
  person likes, which is safe because a band is written with a round's entry,
  and a move closes the day's short pool (features/matching/rounds.feature), so
  it is one new reading a night. A filter on distance is
  features/matching/filters.feature's. There is one pond, the country (ADR-061
  §8), and the write that sets a home sets it.

  Scenario: The home is a required step, asked after the age window
    Given a registered account that answered every step before the home
    When it reads its onboarding status
    Then the home is the first step missing and the account is not active
    When it gives a postal code from the list
    Then the account is active and the photos are the first step missing

  Scenario Outline: A postal code is five digits, and anything else is refused
    Given a signed-in account with a home
    When it sends <what>
    Then the answer is 400 validation_failed, nothing it sent is repeated, and its home is as it was

    Examples:
      | what                            |
      | four digits                     |
      | six digits                      |
      | five characters with a letter   |
      | five characters with a space    |
      | the code as a number            |
      | an empty code                   |
      | neither a code nor what to show |
      | a field the route does not know |

  Scenario: A postal code the list lacks is refused by a constant, and nothing is kept
    Given a signed-in account with a home
    When it sends five digits the list lacks
    Then the answer is 400 postal_code_unknown, in the same words for every code and with no detail
    And its home is as it was, and the digits reached no statement

  # What is kept (ADR-061 §2). The figures are Paavo 2026's. A key is an
  # official code, five digits for an area and three for a municipality, so
  # where an area is kept the postal code is kept: no text may say otherwise.

  Scenario Outline: A home keeps the postal area, else its municipality, else the nearest municipality with enough people
    Given home_min_inhabitants is <floor>
    When a person gives <code>, an area of <area> people in a municipality of <municipality>
    Then what is kept is <kept>, <which>

    Examples:
      | floor | code  | area  | municipality | kept  | which                       |
      | 3000  | 00530 | 17951 | 672201       | 00530 | the area                    |
      | 3009  | 27500 | 3009  | 11021        | 27500 | the area                    |
      | 3010  | 27500 | 3009  | 11021        | 050   | its municipality            |
      | 3000  | 83960 | 271   | 9887         | 422   | its municipality            |
      | 3000  | 00230 | 0     | 672201       | 091   | its municipality            |
      | 3042  | 54710 | 1253  | 3042         | 416   | its municipality            |
      | 3043  | 54710 | 1253  | 3042         | 831   | the nearest one with enough |
      | 3000  | 23950 | 458   | 1836         | 684   | the nearest one with enough |

  Scenario: An area large enough gives way where too few would be left behind its municipality's key
    Given a floor of 3000, and Aura, whose two areas have 3455 and 547 people
    When a person gives 21380, the larger
    Then what is kept is the municipality 019, as for everybody of Aura

  Scenario: Whichever the key, at least the floor's number of people stand behind it
    Given every postal code on the list, read through the floor
    When the people of each code are counted for the key it keeps
    Then no key that anybody keeps has fewer than the floor

  Scenario: The digits of an area too small to keep are looked up in memory and gone
    Given a signed-in account
    When it gives the postal code of an area under the floor
    Then its row holds the municipality's number, and the digits reached no statement and no row

  Scenario: A raised floor coarsens every read at once, and a lowered one gives back only what the row still holds
    Given one person whose home is the area 00530, shown on their card, and another whose home is the municipality 422
    When home_min_inhabitants is raised to 20000
    Then the first person's home reads as the municipality 091 from the next read: their card says the town, and bands are measured from its centre
    When home_min_inhabitants is lowered to 1
    Then the first person's home reads as the area 00530 again, as their row still held it
    And the second person's home reads as the municipality 422 still

  # The card (ADR-061 §3). Both of a place's names go to the phone, and the
  # reader's language picks one; English reads Finnish, and no sentence is built
  # around a name (TD-17).

  Scenario Outline: A card says the town, or the area where the person asked for it, and nothing else of the home
    Given a person who gave <code> and shows <shown>
    When another person reads their card
    Then the card's place is <place>, with no digits and no other name of the home

    Examples:
      | code  | shown    | place                  |
      | 00530 | the town | Helsinki, Helsingfors  |
      | 00530 | the area | Kallio, Berghäll       |
      | 85100 | the town | Raahe, Brahestad       |
      | 85100 | the area | Kalajoki Keskus, Kalajoki centrum |
      | 83960 | the town | Joensuu, Joensuu       |

  Scenario: Maarianhamina is a town at any size, so Åland is not sent across the sea
    Given a person who gave 22150 in Jomala, and home_town_min_inhabitants is 20000
    When another person reads their card
    Then the card's place is Maarianhamina, Mariehamn, a town of 11891 people

  Scenario: Nobody of Åland is kept across the sea while Åland has a place large enough
    Given a person who gave 22840 in Brändö, nearer Uusikaupunki than any place of Åland
    When Kuutti keeps their place
    Then it is Jomala, and their card says Maarianhamina

  Scenario: Where a municipality is kept there is no area to show
    Given a person whose home is a municipality
    When they ask to show their area
    Then the answer has a town, no area and no area shown

  Scenario: A new home starts from the town again, unless the same request says otherwise
    Given a person who shows their area
    When they give another postal code
    Then the answer shows the town
    When they give a third one and ask to show its area in the same request
    Then the answer shows that area

  # Changing it, and the pond it sets (ADR-061 §1 and §8).

  Scenario: A home changes whenever the person likes, and the earlier one is gone
    Given a person with a home and a place at the gate
    When they give another postal code, and another straight after
    Then both are taken, no date is stored, and only the last home is held anywhere
    And their pond and their place at the gate are as they were

  Scenario: The home write sets the one pond, and reading the status sets nothing
    Given a pond whose slug matching_config names as the default pond
    When a registered account reads its onboarding status
    Then it has no pond, and no step asks for one
    When it gives a postal code from the list
    Then it is in that pond

  Scenario: A home write that would leave the account with no pond fails loudly and keeps nothing
    Given matching_config names no live pond as the default pond
    When an account with no pond gives a postal code from the list
    Then the answer is 500, no home is kept, and the step stays open

  Scenario: An active account without a home is in nobody's pool, and the step opens
    Given an active account with a finished profile and no home
    When the gates are counted and it reads its onboarding status
    Then it stays active, it is in nobody's pool, its gate says incomplete, and the home is a missing step
    When it gives a postal code from the list and the gates are counted
    Then it is counted like anybody

  Scenario: A place the list no longer knows reads as no home, and the step opens again
    Given an active account whose kept place has left the list
    When it reads its onboarding status
    Then it has no home, the home is a missing step, and a warn line names no place
    And it is in nobody's pool until it gives a new one

  # Where it travels (ADR-061 §4 and §9).

  Scenario: The home of another account is never served
    Given two accounts, one with a home
    When the other reads its onboarding status and its profile
    Then it sees no home

  Scenario: A half-typed postal code stays on the phone
    Given the home step
    When a person types three digits
    Then the app lists the areas whose code starts with them, and nothing has left the phone
    When they choose one of the areas
    Then its five digits are sent once, in the request's body

  Scenario: Erasure leaves no home on the tombstone
    Given a person with a home, whose card says their area
    When they delete their account
    Then the tombstone holds no place and shows no area

  Scenario: The export says the home in words, never a key
    Given a person who gave 00530, whose card says the town
    When they download their export
    Then it says the place Kallio and the card's Helsinki, and holds no key

  Scenario: A home reaches no log line, no error and no event
    Given a signed-in account with the research consent
    When it gives a postal code from the list, one the list lacks, and something that is no postal code
    Then the write's log line names the account alone
    And no log line, error detail or event holds the digits or the place

  Scenario: A moderator reads no home
    Given a person with a home
    When a moderator opens their account
    Then the page says nothing of where they live
