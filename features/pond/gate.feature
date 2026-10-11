# features/pond/gate.feature
Feature: The pond gate
  Between a finished profile and the first round stand two things (TD-10,
  TD-13, TD-14; #94, #147, ADR-015). Admission: most people are let into
  their pond at once; a person competes for every gender they seek but their
  own, and where the people competing for a gender are more than that gender
  can bear, its newcomers wait in the order they registered, whatever label
  they chose for themselves. And the gate: matching opens for a person when
  enough people are there who match what they seek, whose wishes they match,
  and who want the same thing or are open to either. The rules name no
  gender, no hard filter is ever crossed (rule 7), and nobody is let out
  again when the pond drifts. What a person is told of it is said in tens, never exactly,
  and only the night moves it: a figure that answered every question put to
  it would say what one other person seeks (TD-14).

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

  Scenario Outline: The sheet's examples of who is shown to whom, by gender and seek
    Given a <a_gender> seeking <a_seeks> and a <b_gender> seeking <b_seeks>, both of thirty, open to either and to any age
    Then they are shown to each other: <shown>

    Examples:
      | a_gender   | a_seeks              | b_gender   | b_seeks              | shown |
      | man        | man                  | man        | man                  | yes   |
      | woman      | woman,man            | man        | woman                | yes   |
      | woman      | non_binary           | non_binary | woman                | yes   |
      | woman      | non_binary           | non_binary | man                  | no    |
      | non_binary | woman                | woman      | man                  | no    |
      | man        | woman                | woman      | woman,man,non_binary | yes   |
      | non_binary | woman,man,non_binary | man        | woman                | no    |

  Scenario: The smaller group is always let in, the larger while it is at most its share
    Given a pond where six of one group and four of the other are let in, all seeking the other
    When two more of the larger group finish their profile
    Then they wait, first and second, in the order they registered
    When one of the smaller group finishes their profile
    Then that one is let in, and the first in line with them
    And the one who is left is first in line

  Scenario: A person competes for whom they seek, whatever label they chose for themselves
    Given a pond where the people competing for one gender are at their ratio
    When a non-binary person who seeks that gender finishes their profile, and a person of the other gender who seeks it
    Then both wait in the same line, in the order they registered, and neither is let in before the other

  Scenario: A newcomer of the smaller group opens the way for those who waited
    Given a pond where three of one group are let in and two more of it wait
    When three of the other group finish their profile and the gates are counted
    Then the three are let in, and so is the one who waited longest
    And the other one is first in the waitlist

  Scenario: People who compete for nobody never wait, and seeking one's own gender too opens no door
    Given a pond where one group is far over its share
    When a person who seeks only their own gender finishes their profile, and a person of the larger group who seeks their own gender too
    Then the first is let in at once and the second waits in the line, as anybody of the larger group does

  Scenario: Nobody is let out again when the pond drifts
    Given a pond where the larger group is at its share and everybody is let in
    When people of the smaller group leave and the gates are counted
    Then everybody who was let in is let in still

  Scenario: Matching opens when the pool reaches gate_k, and stays open
    Given a person let into a pond where twenty-nine people match them, and gate_k is thirty
    When the gates are counted
    Then the person's gate is closed and they are told that about ten more are needed
    When one more person who matches joins and the gates are counted
    Then the person's gate is open
    When five of those people leave and the gates are counted
    Then the person's gate is open still

  Scenario: What a person is told is said in tens, and follows slowly
    Given a person let into a pond where seventeen people match them, and gate_k is thirty
    When the gates are counted
    Then the person is told that about twenty more are needed
    When two more people who match join and the gates are counted
    Then the person is told twenty still
    When one more joins and the gates are counted
    Then the person is told ten
    When that one leaves again and the gates are counted
    Then the person is told ten still

  Scenario: The place in the line is said in tens
    Given a pond where eleven of the larger group wait
    When the gates are counted
    Then the first ten in the line are each told that they are among the next ten
    And the eleventh that they are among the next twenty

  Scenario: A change of the step says nothing anew
    Given a person told that about ten more are needed, whose pool has since shrunk by less than a step
    When the step is raised to twenty
    Then they are told ten still, before the gates are counted and after
    When the step is lowered to ten again and the gates are counted
    Then they are told ten still

  Scenario: Only a finished profile and current consents are counted
    Given a pond with a person whose profile lacks its photos, one whose consent is for an older wording, a shadow-banned one and a paused one
    When the gates are counted
    Then none of them is in anybody's pool
    And the shadow-banned person has a gate of their own, like anybody

  Scenario: Counting twice changes nothing
    Given a pond that was counted
    When it is counted again at once
    Then every place, every figure and every date is what it was

  Scenario: A person learns where they stand the first time they ask
    Given a person who finished their profile since the last count
    When they ask for their gate
    Then they are counted then and there, and told their place or how many are needed
    And nobody else's figure has moved

  Scenario: Another person's gate is never served
    Given two people in one pond, one of them waiting
    When the other asks for their gate
    Then they are told their own and nothing of the first

  Scenario: The place stays behind with the pond, and the night says the new one
    Given a person for whom matching is open in their pond
    When they choose another pond
    Then they are neither let in nor in the line there, and asking counts nothing
    When the gates are counted
    Then they are told where they stand in the pond they went to

  Scenario: Admission is decided anew for a person who joins a contest that waits
    Given a person let in who competes for nobody, in a pond where the people competing for one gender are over their ratio
    When they declare that they seek that gender too
    Then they are neither let in nor in the line until the gates are counted
    When the gates are counted
    Then they wait behind everybody who competes for that gender and registered before them
    And a change of gender that keeps the same contests, or a narrower window of ages, takes nothing back

  Scenario: Erasure removes the place at the gate
    Given a person with a place at the gate
    When they delete their account
    Then no row of the gate names them
