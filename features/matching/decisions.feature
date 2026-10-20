# features/matching/decisions.feature
Feature: Today's round, seen and decided
  A round is what one person is shown on one Finnish calendar day (#96,
  TD-11, ADR-034): its cards in order, each with why it is there (TD-12).
  The phone reports a card seen; the person likes or passes it, and may
  change that until the day ends (the maintainer, 19/10/2026). A card of a
  day that has ended can no longer be decided: its round expired with it. A
  card that can no longer be shown, by a block either way or a sanction, is
  left out and cannot be decided. Erasure removes the person's rounds and
  every entry in which they are somebody's card. The research events carry
  places, reasons and coarse times, never whom (rule 5).

  Scenario: Today's round shows its cards in order, each with its reason and the person's own decision
    Given a round was built for "A" today with "B", "C" and "D"
    When "A" reads today's round
    Then the three cards come in their places, each with its reason, and none decided

  Scenario: Before the day's round is built, today's round has no cards
    Given no round was built for "A" today
    When "A" reads today's round
    Then the answer names today and has no cards

  Scenario: A card that can no longer be shown is left out, and cannot be seen or decided
    Given a round was built for "A" today with "B" and "C"
    And "A" blocked "B" and "C" was suspended since
    When "A" reads today's round, reports both seen and likes both
    Then neither card is shown, and every write answers not_found with nothing written

  Scenario: A card seen is recorded once, as profile_viewed
    Given a round was built for "A" today with "B", and "A" is in the study
    When "A" reports the card seen twice
    Then its seen time is the first report's, and one profile_viewed names its place and reason

  Scenario: A like is recorded, and the same decision again writes nothing
    Given a round was built for "A" today with "B", and "A" is in the study
    When "A" likes the card twice
    Then the card is liked at the first time, and one like event says it was not revised

  Scenario: A decision may change until the day ends, and the change says it was revised
    Given a round was built for "A" today with "B", and "A" is in the study
    When "A" likes the card, then passes it, then likes it again
    Then the card is liked at the last time, and the events are like, pass and like, the last two revised

  Scenario: A card of a day that has ended cannot be seen or decided
    Given a round was built for "A" yesterday with "B"
    When "A" reports yesterday's card seen and likes it
    Then both answers are round_expired and nothing is written

  Scenario: The round is complete once every card that can be shown is decided
    Given a round was built for "A" today with "B" and "C", and "C" was suspended since
    When "A" passes "B"
    Then the round is complete

  Scenario: Two devices deciding the same card at once are taken one after the other
    Given a round was built for "A" today with "B"
    When one device likes the card while another passes it at the same moment
    Then the second waits for the first, and the card ends with the second's decision

  Scenario: Only the person's own round is read or decided
    Given rounds were built for "A" and "E" today
    When "E" reports seen and decides at "A"'s places
    Then "E"'s own cards are written, and "A"'s are untouched

  Scenario: Erasure removes the person's rounds and every entry in which they are somebody's card
    Given rounds were built for "A" and "B" today, each the other's card
    When "B" deletes their account
    Then "B"'s round is gone, and "A"'s round keeps its other cards without "B"

  Scenario: The person's export lists their own rounds, never whom
    Given a round was built for "A" today with "B", and "A" liked it
    When "A" downloads their data
    Then the round is listed by its day with the card's place, reason and decision in words, and "B" is named nowhere

  Scenario: A round built is a round_built event with its size and its count for each reason
    Given "A" is in the study
    When a round is built for "A" with two cards that match every filter and one that liked "A"
    Then one round_built says three cards, two matching every filter and one liked-you

  # The day's likes (#98's first cut, ADR-036; the maintainer, 20/10/2026):
  # one budget for everybody, like_budget_balanced a Finnish day, counted
  # from the day's standing decisions. Liking back somebody who liked the
  # person answers a like and is free; a pass is never counted.

  Scenario: The day's likes stop at the budget, and the next is refused with the time they come back
    Given like_budget_balanced is 2 and a round was built for "A" today with "B", "C" and "D"
    When "A" likes all three
    Then "B" and "C" are liked, and the like of "D" is refused with the wait until midnight, nothing of it written

  Scenario: A like back on a card of somebody who liked the person is free
    Given like_budget_balanced is 1 and a round was built for "A" today with "B" who liked "A", and "C"
    When "A" likes "C" and then "B"
    Then both are liked

  Scenario: A pass is never counted, and a like taken back gives its place back
    Given like_budget_balanced is 1 and a round was built for "A" today with "B", "C" and "D"
    When "A" passes "B", likes "C", is refused "D", then changes "C" to a pass
    Then "A" can like "D"

  Scenario: Two devices liking at once cannot pass the budget together
    Given like_budget_balanced is 1 and a round was built for "A" today with "B" and "C"
    When one device likes "B" while another likes "C"
    Then the second waits for the first, and its like is refused
