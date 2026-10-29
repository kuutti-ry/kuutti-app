# features/matching/fish.feature
Feature: The fish, a like that says a little more
  A fish (#378, ADR-039; the maintainer, 20/10/2026) is a like with a mark:
  fish_budget of them in each fish_window_days counted from a Monday, one a
  calendar week, Monday to Sunday in Finland (the maintainer, 29/10/2026,
  #475; one in any seven days, rolling, before). It goes to the front
  of the other person's liked-you places, ahead of ordinary likes, oldest
  first within each, labelled as a fish. It is a like for every other rule:
  the day's likes, the expiry, the match, and the sender learns nothing
  unless it becomes a match. The sender's own round says whether a fish can
  go today, and nothing of when the next comes: on Monday. Nobody can buy one, an
  invitation may earn one (earned.feature), and nothing counts how many a
  person received.

  Scenario: A fish sent today is at the front of the recipient's next round, ahead of every ordinary like
    Given "B" liked "A" two days ago, and "C" sent "A" a fish yesterday
    When the night builds the rounds
    Then "A"'s round opens with "C", labelled fish, then "B", labelled liked you

  Scenario Outline: Fish and likes waiting on one person come fish oldest first, then likes oldest first
    Given fish from "F1" three days ago and "F2" one day ago, and likes from "L1" four, "L2" two and "L3" one day ago, all waiting on "A"
    When the night builds the rounds
    Then "<sender>" is at place <place> of "A"'s round, labelled <label>

    Examples:
      | sender | place | label     |
      | F1     | 1     | fish      |
      | F2     | 2     | fish      |
      | L1     | 3     | liked you |
      | L2     | 4     | liked you |
      | L3     | 5     | liked you |

  Scenario: A second fish in the same calendar week is refused until Monday, and nothing is written
    Given "A" sent a fish on Tuesday, and it is Friday
    When "A" sends a fish on a card of today
    Then it is refused as fish_budget_exceeded, with the wait until the midnight that begins Monday, and the card stays undecided

  Scenario: Last week's fish is behind Monday's midnight, and a fish goes at 00:01
    Given "A" sent a fish on Sunday
    When "A" sends a fish on a card of Monday at 00:01
    Then the fish is sent

  Scenario: A fish of last Sunday is last week's, though fewer than seven days ago
    Given "A" sent a fish on Sunday, and it is Friday
    When "A" sends a fish on a card of today
    Then the fish is sent

  Scenario: A round read after the week's fish offers no other fish this week
    Given "A" sent a fish today
    When "A" reads today's round
    Then it says no fish can go today

  Scenario: A fish changed to a like or a pass the same day is given back
    Given "A" sent a fish today
    When "A" changes it to a like, and sends a fish on another card
    Then the second fish is sent

  Scenario: A fish counts against the day's like budget
    Given like_budget_balanced is 1
    When "A" sends a fish, then likes another card
    Then the like is refused as like_budget_exceeded

  Scenario: A fish on a card of somebody whose like waits is a like
    Given "B" liked "A" yesterday, and "B" is in "A"'s round today as liked you
    When "A" sends "B" a fish
    Then it is recorded as a like, no fish is spent, and the two are a match
