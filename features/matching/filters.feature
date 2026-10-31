# features/matching/filters.feature
Feature: The filters, hard both ways, and the soft preferences that only order
  Nobody is shown to somebody who did not opt into them, in either direction
  (rule 7, the field sheet's mutual rule; #87). The hard filters are one
  function, inEachOthersPool, which the gate's count and the round builder
  both ask (ADR-015 §1). Gender and whom one seeks, the age window and what
  one is here for are features/pond/gate.feature's examples; a block is
  features/safety/blocks.feature's. The deal-breakers are here. A
  deal-breaker (#149) filters on a field the holder answered themselves; with
  that answer taken back it is paused and filters nothing. An answer the
  person hid from their card is still an answer (#515): only the card leaves it
  out. The soft
  preferences (education, drinking, the attitude to drugs) are a person's own
  answers. They only order a round, counted where the two are similar from
  both sides. They never take anybody out of a pool, and never reach a card,
  an event or a log line as a number.

  Scenario Outline: A deal-breaker lets through only the answers its holder accepts, asked from either side
    Given a person with a deal-breaker on <field> accepting <accept>, <unknown> people who did not answer
    And another person who answered <answer>, the two otherwise in each other's pool
    Then they are <in> each other's pool, asked from either side, whichever of them holds it

    Examples:
      | field     | accept         | unknown | answer          | in     |
      | smoking   | never          | without | never           | in     |
      | smoking   | never          | without | regularly       | not in |
      | smoking   | never,quitting | without | quitting        | in     |
      | smoking   | never          | without | nothing         | not in |
      | smoking   | never          | with    | nothing         | in     |
      | smoking   | never          | with    | vaping          | not in |
      | languages | fi             | without | sv,fi           | in     |
      | languages | fi,sv          | without | en              | not in |
      | languages | fi             | with    | nothing         | in     |
      | hasKids   | no             | without | yes_not_with_me | not in |
      | monogamy  | monogamous     | without | monogamous      | in     |

  Scenario: The deal-breakers of both people are asked, each against the other's answers
    Given two people, each with a deal-breaker the other's answer passes
    When either of them changes that answer to one the other does not accept
    Then they are out of each other's pool, asked from either side

  Scenario: A paused deal-breaker filters nothing
    Given a person with a deal-breaker on smoking accepting never, and another who smokes regularly
    When the first takes their own smoking answer back
    Then the two are in each other's pool, asked from either side
    And answering again takes them out of it once more

  Scenario Outline: A hidden answer counts under a deal-breaker as a shown one does
    Given "A"'s deal-breaker on smoking accepts never, <unknown> people who did not answer
    And "B" smokes regularly and "C" never, and both hid it from their cards
    When the night builds the rounds
    Then "C" is in "A"'s round and "B" is not

    Examples:
      | unknown |
      | with    |
      | without |

  Scenario: Hiding one's own answer leaves a deal-breaker on it in force
    Given "A"'s deal-breaker on smoking accepts never, and "B" smokes regularly and "C" never
    When "A" hides their own smoking answer from their card
    Then the deal-breaker is not paused, "C" is in "A"'s round and "B" is not

  Scenario: The gate's count leaves a pair a deal-breaker excludes out of each other's pool
    Given thirty-one people of one pond, each in every other's pool
    And one of them has a deal-breaker on smoking that another's answer does not pass
    When the night counts the gates
    Then neither of the two counts toward the other's figure
    And after the holder takes their own smoking answer back, the next night counts both again

  Scenario Outline: Soft preferences count only what is similar from both sides
    Given one person who answered <mine> and another who answered <theirs>
    Then they are similar on <count> soft fields, asked from either side

    Examples:
      | mine                                               | theirs                                                  | count |
      | drinking=never                                     | drinking=never                                          | 1     |
      | drinking=never                                     | drinking=rarely                                         | 1     |
      | drinking=never                                     | drinking=socially                                       | 0     |
      | drinking=socially                                  | drinking=often                                          | 1     |
      | education=amk                                      | education=kandi                                         | 1     |
      | education=toinen_aste                              | education=kandi                                         | 0     |
      | education=maisteri                                 | education=tohtori                                       | 1     |
      | education=peruskoulu                               | education=tohtori                                       | 0     |
      | drugsAttitude=not_my_thing                         | drugsAttitude=dont_mind                                 | 1     |
      | drugsAttitude=not_my_thing                         | drugsAttitude=fine_with_it                              | 0     |
      | drinking=never                                     | nothing                                                 | 0     |
      | drinking=never                                     | education=amk                                           | 0     |
      | education=kandi,drinking=rarely,drugsAttitude=dont_mind | education=maisteri,drinking=socially,drugsAttitude=fine_with_it | 3     |
      | education=kandi,drinking=rarely                    | education=peruskoulu,drinking=rarely                    | 1     |

  Scenario: Soft preferences never take anybody out of a pool, nor bring anybody into one
    Given any two people
    When their soft answers change in any way
    Then whether they are in each other's pool does not change

  Scenario: The soft count is read by the round's order alone
    Then no file of the apps reads the soft count but its own, until the round builder orders a round with it (#95)
