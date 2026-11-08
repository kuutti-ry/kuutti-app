# features/matching/filters.feature
Feature: The filters, hard both ways, and the soft preferences that only order
  Nobody is shown to somebody who did not opt into them, in either direction
  (rule 7, the field sheet's mutual rule; #87). The hard filters are one
  function, inEachOthersPool, which the queue asks of everybody (ADR-035 §2),
  and both people's filters are asked on every read of a card and on every new
  like (ADR-062 §8). Gender and whom one seeks, the age window and what one is
  here for are the two outlines below; a block is
  features/safety/blocks.feature's. The deal-breakers are here. A
  deal-breaker (#149) filters on a field the holder answered themselves; with
  that answer taken back it is paused and filters nothing. An answer the
  person hid from their card is still an answer (#515): only the card leaves it
  out. One on height (#508) accepts no list of answers: it is one relation of
  the other person's height to the holder's own, and everyone is having none.
  One on distance (#514, ADR-061 §7) has no field: it accepts the bands of the
  pair's distance (rounds.feature) up to nearby, close or around, since far
  accepted is no filter. Everybody has a home, so it is never paused and nobody
  is unknown to it. Without one the whole country is a person's pool.
  The soft preferences (education, drinking, the attitude to drugs) are a
  person's own answers. They only order the new people of a queue, counted
  where the two are similar from both sides. They never take anybody out of a
  pool, and never reach a card, an event or a log line as a number.

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

  Scenario Outline: A height deal-breaker compares the other person's height with the holder's own, asked from either side
    Given a person of 170 cm with a deal-breaker on height, <relation>, <unknown> people who did not answer
    And another person whose height is <theirs>, the two otherwise in each other's pool
    Then they are <in> each other's pool, asked from either side, whichever of them holds it

    Examples:
      | relation      | unknown | theirs  | in     |
      | taller        | without | 171     | in     |
      | taller        | without | 170     | not in |
      | taller        | without | 169     | not in |
      | at_least_mine | without | 171     | in     |
      | at_least_mine | without | 170     | in     |
      | at_least_mine | without | 169     | not in |
      | shorter       | without | 169     | in     |
      | shorter       | without | 170     | not in |
      | shorter       | without | 171     | not in |
      | taller        | without | nothing | not in |
      | taller        | with    | nothing | in     |
      | shorter       | with    | 171     | not in |

  Scenario: Two height deal-breakers are each asked from their holder's own height
    Given a person of 165 cm who asks for somebody taller and a person of 180 cm who asks for somebody shorter
    Then they are in each other's pool, asked from either side
    And two people who both ask for somebody taller are never in each other's pool, whatever their heights

  Scenario: A height deal-breaker waits for its holder's own height
    Given a person of 170 cm with a deal-breaker on height, taller, and a person of 165 cm
    When the first takes their own height back
    Then the two are in each other's pool, asked from either side
    And answering again takes them out of it once more

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
    When "A" reads the queue
    Then "C" is in "A"'s queue and "B" is not

    Examples:
      | unknown |
      | with    |
      | without |

  Scenario: Hiding one's own answer leaves a deal-breaker on it in force
    Given "A"'s deal-breaker on smoking accepts never, and "B" smokes regularly and "C" never
    When "A" hides their own smoking answer from their card
    Then the deal-breaker is not paused, "C" is in "A"'s queue and "B" is not

  Scenario: The round leaves a pair a deal-breaker excludes out of each other's cards
    Given people of an open pond, each in every other's pool
    And one of them has a deal-breaker on smoking that another's answer does not pass
    When each of them reads the queue
    Then neither of the two is a card in the other's queue
    And after the holder takes their own smoking answer back, the next day's read shows them to each other

  Scenario Outline: Two people are in each other's pool only when each passes what the other asked for
    Given a <a_gender> of <a_age> who seeks <a_seeks> between <a_min> and <a_max>, here for <a_intent>
    And a <b_gender> of <b_age> who seeks <b_seeks> between <b_min> and <b_max>, here for <b_intent>
    Then they are <in> each other's pool, asked from either side

    Examples:
      | a_gender   | a_age | a_seeks          | a_min | a_max | a_intent       | b_gender   | b_age | b_seeks    | b_min | b_max | b_intent       | in     |
      | woman      | 30    | man              | 25    | 40    | open_to_either | man        | 35    | woman      | 25    | 40    | open_to_either | in     |
      | woman      | 30    | man              | 25    | 40    | open_to_either | man        | 35    | man        | 25    | 40    | open_to_either | not in |
      | woman      | 30    | man              | 25    | 34    | open_to_either | man        | 35    | woman      | 25    | 40    | open_to_either | not in |
      | woman      | 41    | man              | 25    | 45    | open_to_either | man        | 35    | woman      | 25    | 40    | open_to_either | not in |
      | woman      | 30    | woman            | 25    | 40    | open_to_either | woman      | 28    | woman      | 25    | 40    | open_to_either | in     |
      | non_binary | 30    | man,non_binary   | 25    | 40    | open_to_either | man        | 35    | non_binary | 25    | 40    | open_to_either | in     |
      | non_binary | 30    | man              | 25    | 40    | open_to_either | man        | 35    | woman      | 25    | 40    | open_to_either | not in |
      | woman      | 25    | man              | 25    | 40    | open_to_either | man        | 40    | woman      | 25    | 40    | open_to_either | in     |
      | woman      | 30    | man              | 25    | 40    | long_term      | man        | 35    | woman      | 25    | 40    | long_term      | in     |
      | woman      | 30    | man              | 25    | 40    | long_term      | man        | 35    | woman      | 25    | 40    | casual         | not in |
      | woman      | 30    | man              | 25    | 40    | long_term      | man        | 35    | woman      | 25    | 40    | open_to_either | in     |
      | woman      | 30    | man              | 25    | 40    | open_to_either | man        | 35    | woman      | 25    | 40    | casual         | in     |
      | woman      | 30    | man              | 25    | 40    | casual         | man        | 35    | woman      | 25    | 40    | casual         | in     |
      | woman      | 30    | man              | 25    | 40    | dance_partner  | man        | 35    | woman      | 25    | 40    | dance_partner  | in     |
      | woman      | 30    | man              | 25    | 40    | dance_partner  | man        | 35    | woman      | 25    | 40    | long_term      | not in |
      | woman      | 30    | man              | 25    | 40    | dance_partner  | man        | 35    | woman      | 25    | 40    | casual         | not in |
      | woman      | 30    | man              | 25    | 40    | dance_partner  | man        | 35    | woman      | 25    | 40    | open_to_either | not in |

  Scenario Outline: The sheet's examples of who is shown to whom, by gender and seek
    Given a <a_gender> seeking <a_seeks> and a <b_gender> seeking <b_seeks>, both of thirty, both here for <intent> and open to any age
    Then they are shown to each other: <shown>

    Examples:
      | a_gender   | a_seeks              | b_gender   | b_seeks              | intent         | shown |
      | man        | man                  | man        | man                  | open_to_either | yes   |
      | man        | man                  | man        | man                  | dance_partner  | yes   |
      | woman      | woman,man            | man        | woman                | open_to_either | yes   |
      | woman      | woman,man            | man        | woman                | dance_partner  | yes   |
      | woman      | non_binary           | non_binary | woman                | open_to_either | yes   |
      | woman      | non_binary           | non_binary | woman                | dance_partner  | yes   |
      | woman      | non_binary           | non_binary | man                  | open_to_either | no    |
      | woman      | non_binary           | non_binary | man                  | dance_partner  | no    |
      | non_binary | woman                | woman      | man                  | open_to_either | no    |
      | non_binary | woman                | woman      | man                  | dance_partner  | no    |
      | man        | woman                | woman      | woman,man,non_binary | open_to_either | yes   |
      | man        | woman                | woman      | woman,man,non_binary | dance_partner  | yes   |
      | non_binary | woman,man,non_binary | man        | woman                | open_to_either | no    |
      | non_binary | woman,man,non_binary | man        | woman                | dance_partner  | no    |

  # A deal-breaker on distance (#514, ADR-061 §7), the seventh, asked of the
  # pair's band instead of an answer. Relaxing one for the day is otherwise
  # short-pool.feature's.

  Scenario Outline: A distance deal-breaker lets through only the bands its holder accepts, asked from either side
    Given a person with a deal-breaker on distance accepting <accept>, the bands ending at 5, 15 and 50 km
    And another person whose home is <km> km from theirs, the two otherwise in each other's pool
    Then they are <in> each other's pool, asked from either side, whichever of them holds it

    Examples:
      | accept              | km    | in     |
      | nearby              | 0     | in     |
      | nearby              | 4.99  | in     |
      | nearby              | 5     | not in |
      | nearby,close        | 5     | in     |
      | nearby,close        | 14.99 | in     |
      | nearby,close        | 15    | not in |
      | nearby,close,around | 15    | in     |
      | nearby,close,around | 49.99 | in     |
      | nearby,close,around | 50    | not in |
      | nearby,close,around | 900   | not in |

  Scenario: Without a deal-breaker on distance the whole country is one pool
    Given two people 900 km apart, otherwise in each other's pool, neither with a deal-breaker on distance
    Then they are in each other's pool, asked from either side

  Scenario: Two distance deal-breakers are both asked, so the narrower decides
    Given a person who accepts up to around, and another 10 km away who accepts nearby
    Then they are out of each other's pool, asked from either side
    And 3 km apart they are in it

  Scenario: A distance deal-breaker is never paused, for everybody has a home
    Given a person who answered nothing on their profile, with a deal-breaker on distance accepting nearby, and another 10 km away
    Then they are out of each other's pool, asked from either side
    And the deal-breaker does not read as paused

  Scenario: A distance deal-breaker keeps the two out of each other's rounds
    Given "A"'s deal-breaker on distance accepts nearby, "B" lives nearby and "C" close
    When each of them reads the queue
    Then "A" and "B" are in each other's rounds, "C" is not in "A"'s, and "A" is not in "C"'s

  Scenario: A short round offers a distance deal-breaker set aside, never for those who did not answer
    Given "A"'s deal-breaker on distance accepts nearby, and twelve people live further away
    When "A" reads today's relaxations
    Then the round is short, and distance is offered set aside alone, 10 more
    And relaxing it for those who did not answer is not found, with nothing written

  Scenario: A distance deal-breaker set aside lets in people beyond it, never against their own filters
    Given "A"'s deal-breaker on distance accepts nearby, and "B" and "C" live further away
    And "B"'s own deal-breaker on distance excludes "A"
    When "A" sets distance aside for today
    Then "C" is added to "A"'s round, labelled relaxed with distance, and "B" is not

  Scenario: A card never says that its person did not answer a distance
    Given "A"'s deal-breaker on distance lets "B" through
    When "A" reads the queue
    Then "B"'s card lists nothing as not answered

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
    Then no file of the apps reads the soft count but its own and the order of new people (#95)

  # Filters at once (ADR-062 §8, the maintainer, 01/11/2026): a card that does not
  # fit now is left out while it does not fit, and every change of filters or home
  # works on the next read, the narrow ones and the wide ones alike. That a person
  # can aim at somebody this way, or narrow down an area by moving home, he
  # accepted. Gender's thirty days stay (preferences.feature).

  Scenario Outline: A change of what fits works on the next read, whoever makes it
    Given "B" is undecided in "A"'s queue today
    When <who> <change>
    Then "B"'s card is left out of "A"'s next read, and stays in the log
    When that is changed back
    Then "B"'s card comes again, at its place

    Examples:
      | who | change                                 |
      | "A" | seeks somebody else                    |
      | "B" | seeks somebody else                    |
      | "A" | narrows the age window                 |
      | "B" | narrows the age window                 |
      | "A" | wants something else from it           |
      | "B" | wants something else from it           |
      | "A" | sets a deal-breaker "B" fails          |
      | "B" | sets a deal-breaker "A" fails          |
      | "A" | moves past their distance deal-breaker |
      | "B" | moves past "A"'s distance deal-breaker |

  Scenario: One change narrows and widens at once, and both work on the next read
    Given "B" is undecided in "A"'s queue today, and "C" has never fit "A"
    When "A" changes whom they seek from "B"'s gender to "C"'s
    Then the next read leaves "B" out and brings "C"

  Scenario: Widening at the queue's end works on the next read
    Given "A" has reached the queue's end, and "C" does not fit "A"
    When "A" widens whom they seek
    Then the next read brings "C"

  Scenario Outline: A new like asks both people's filters, and a card that no longer fits answers not_found
    Given "B" is undecided in "A"'s queue today
    When <who> narrows so that the two no longer fit, and "A" likes the card
    Then the answer is not_found, nothing is written, and the like spends nothing

    Examples:
      | who |
      | "A" |
      | "B" |

  Scenario Outline: A pass or a skip of a card that no longer fits still works
    Given "B" is undecided in "A"'s queue today, and the two no longer fit
    When "A" <decides> the card
    Then the decision is written

    Examples:
      | decides |
      | passes  |
      | skips   |

  Scenario: A like taken back works when the card no longer fits
    Given "A" liked "B" today, and the two no longer fit
    When "A" changes it to a pass
    Then the pass is written, and the like is gone

  Scenario: A like on a relaxed card goes through while the day's relaxation stands
    Given "A" relaxed smoking for today, and "B", who did not answer it, came in by it
    When "A" likes the card
    Then the like is written

  Scenario: A like back asks the filters with what the other person's like waived
    Given "B" relaxed smoking for a day and liked "A", who smokes, and that like waits on "A"
    When "A" reads the queue and likes "B"
    Then "B"'s card comes, and the two are a match
