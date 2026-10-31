# features/matching/filters.feature
Feature: The filters, hard both ways, and the soft preferences that only order
  Nobody is shown to somebody who did not opt into them, in either direction
  (rule 7, the field sheet's mutual rule; #87). The hard filters are one
  function, inEachOthersPool, which the round builder asks of everybody
  (ADR-035 §2). Gender and whom one seeks, the age window and what one is
  here for are the two outlines below; a block is
  features/safety/blocks.feature's. The deal-breakers are here. A
  deal-breaker (#149) filters on a field the holder answered themselves; with
  that answer taken back it is paused and filters nothing. An answer the
  person hid from their card is still an answer (#515): only the card leaves it
  out. One on height (#508) accepts no list of answers: it is one relation of
  the other person's height to the holder's own, and everyone is having none.
  The soft preferences (education, drinking, the attitude to drugs) are a
  person's own answers. They only order a round, counted where the two are
  similar from both sides. They never take anybody out of a pool, and never
  reach a card, an event or a log line as a number.

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

  Scenario: The round leaves a pair a deal-breaker excludes out of each other's cards
    Given people of an open pond, each in every other's pool
    And one of them has a deal-breaker on smoking that another's answer does not pass
    When the night builds the rounds
    Then neither of the two is a card in the other's round
    And after the holder takes their own smoking answer back, the next night shows them to each other

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
